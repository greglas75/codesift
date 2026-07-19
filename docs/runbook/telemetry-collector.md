# Telemetry collector runbook (coding-vps)

Shared collector for codesift + zuvo anonymous/opt-in telemetry.
Spec: `docs/specs/2026-07-19-telemetry-spec.md` §5. Source: `services/telemetry-collector/`.

## What it is
- Zero-dep Node HTTP service (`server.mjs`), runs as **`gha`** via systemd.
- **Loopback-only** (`127.0.0.1:5599`) — never bind a public interface directly.
- `POST /ingest/codesift`, `POST /ingest/zuvo`, `GET /health`.
- Auth: `x-api-key` == token in `collector.env`. Writes `data/<ns>/<UTC-day>.jsonl`.
- Rate-limit per `anon_id` (120/min default), body cap 256 KB, **no client IP persisted**
  (IP only in the proxy access log). Schema-tolerant: unknown fields + newer
  `schema_version` accepted and logged.

## Deployed layout (already provisioned 2026-07-19)
```
/home/gha/telemetry-collector/server.mjs
/home/gha/telemetry-collector/collector.env      # CODESIFT_COLLECTOR_TOKEN, COLLECTOR_PORT=5599, COLLECTOR_HOST=127.0.0.1, COLLECTOR_DATA_DIR
/home/gha/telemetry-collector/data/<ns>/<day>.jsonl
/etc/systemd/system/telemetry-collector.service  # User=gha, EnvironmentFile, hardened
```
Port **127.0.0.1:5599** is recorded in `~/.claude/rules/self-hosted-ci-runner.md` (CI port registry).

## Deploy / update
```bash
scp services/telemetry-collector/server.mjs root@100.110.133.83:/home/gha/telemetry-collector/server.mjs
ssh root@100.110.133.83 'chown gha:gha /home/gha/telemetry-collector/server.mjs && systemctl restart telemetry-collector'
```

## Verify
```bash
ssh root@100.110.133.83 '
  systemctl is-active telemetry-collector
  curl -s localhost:5599/health
  TOKEN=$(. /home/gha/telemetry-collector/collector.env; echo "$CODESIFT_COLLECTOR_TOKEN")
  curl -s -H "x-api-key: $TOKEN" -XPOST localhost:5599/ingest/codesift -d "{\"schema_version\":1,\"anon_id\":\"probe\",\"tools\":[]}"
'
```

## Public HTTPS exposure — DELIBERATE, fronts production
The reverse proxy is **traefik in docker** (`bot-traefik-1`, compose project `bot` = popebot stack) serving 80/443. It fronts ~20 services. Do NOT edit existing routes. Two additive, reversible options:

**A. Tailnet-only (fleet, no traefik change) — lowest risk.** Set `COLLECTOR_HOST=100.110.133.83` (tailscale IP) in `collector.env`, restart. Fleet machines on tailscale push directly (WireGuard-encrypted); token still required. Public npm installs cannot reach it — use this for Level-2 fleet data first.

**B. Public via traefik (needed for Level-1 public install-base).** Add the collector as a NEW labelled container joined to traefik's docker network (does not touch the `bot` compose file), OR add a file-provider dynamic route. Router: `Host(\`<telemetry-host>\`) && PathPrefix(\`/ingest\`)` → `http://<collector>:5599`, TLS via the existing certresolver. **Rollback:** remove the added container/file; existing routes untouched. Confirm certresolver + entrypoint names from the running traefik before applying.

## Retention (~180 days) — cron reaper
```bash
ssh root@100.110.133.83 'crontab -u gha -l 2>/dev/null; echo "17 4 * * * find /home/gha/telemetry-collector/data -name \"*.jsonl\" -mtime +180 -delete" | crontab -u gha -'
```

## Decommission
```bash
ssh root@100.110.133.83 'systemctl disable --now telemetry-collector; rm /etc/systemd/system/telemetry-collector.service; systemctl daemon-reload; rm -rf /home/gha/telemetry-collector'
```
Then drop the 5599 row from the CI port registry.

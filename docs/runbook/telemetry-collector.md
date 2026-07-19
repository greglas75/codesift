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

## Public HTTPS exposure — LIVE (2026-07-19)
Reachable at **`https://coding.tgmedit.com/ingest/{codesift,zuvo}`**. The reverse
proxy is **traefik in docker** (`bot-traefik-1`, compose project `bot`) serving
80/443 with a Let's Encrypt cert for `coding.tgmedit.com` (already used by the
event-handler router). Exposure is fully **additive + reversible** — no existing
route or the `bot` compose was touched:

1. Collector runs as a **docker container** `telemetry-collector` on network
   `bot_default` (image built from `Dockerfile`, restart=unless-stopped, runs as
   the `gha` uid, `-v /home/gha/telemetry-collector/data:/data`). Traefik reaches
   it by name — no host↔bridge firewall in play (the earlier host-loopback +
   gateway approach 504'd; that's why it's containerized). The systemd unit is
   `disable`d (kept as fallback).
2. Isolated traefik file-provider route `/root/bot/traefik-config/telemetry.yml`:
   router `Host(\`coding.tgmedit.com\`) && PathPrefix(\`/ingest\`)` (more specific
   than the event-handler's bare Host, so `/ingest/*` goes to the collector and
   everything else is unchanged) → service `http://telemetry-collector:5599`,
   `entryPoints: [websecure]`, `tls.certResolver: letsencrypt`.

**Two-tier auth**: `/ingest/codesift` anonymous L1 is **open** (no token — validated
as an L1 shape + rate-limited) so the public install-base can send; `/ingest/zuvo`
and any `level:"full"` codesift payload require the secret (`CODESIFT_COLLECTOR_TOKEN`).

**Rollback:** `rm /root/bot/traefik-config/telemetry.yml` (route gone in seconds) +
`docker rm -f telemetry-collector`. Existing routes/services untouched throughout.

**Deploy/update the container:**
```bash
scp services/telemetry-collector/{server.mjs,Dockerfile} root@100.110.133.83:/home/gha/telemetry-collector/
ssh root@100.110.133.83 'cd /home/gha/telemetry-collector && docker build -q -t telemetry-collector:latest . && \
  docker rm -f telemetry-collector; TOKEN=$(. collector.env; echo $CODESIFT_COLLECTOR_TOKEN); \
  docker run -d --name telemetry-collector --restart unless-stopped --network bot_default \
    --user $(id -u gha):$(id -g gha) -e CODESIFT_COLLECTOR_TOKEN="$TOKEN" -v /home/gha/telemetry-collector/data:/data telemetry-collector:latest'
```

## Retention (~180 days) — cron reaper
```bash
ssh root@100.110.133.83 'crontab -u gha -l 2>/dev/null; echo "17 4 * * * find /home/gha/telemetry-collector/data -name \"*.jsonl\" -mtime +180 -delete" | crontab -u gha -'
```

## Decommission
```bash
ssh root@100.110.133.83 'systemctl disable --now telemetry-collector; rm /etc/systemd/system/telemetry-collector.service; systemctl daemon-reload; rm -rf /home/gha/telemetry-collector'
```
Then drop the 5599 row from the CI port registry.

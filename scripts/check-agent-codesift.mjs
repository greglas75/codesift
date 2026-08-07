#!/usr/bin/env node
/**
 * Is codesift actually reachable for every project an agent might open?
 *
 * This exists because the answer was NO for days and nothing noticed. The machine-wide fallback in
 * `~/.claude.json` spawned `node <dev-tree>/dist/cli.js`, and `npm run build` opens with
 * `rmSync('dist')` — so every build broke codesift for every new session without a per-project
 * entry, which is exactly the population of freshly created worktrees. It surfaced only in agents'
 * retrospectives (`~/.zuvo/retros.log` field 16): 2 `unavailable` out of 90 on 2026-08-03, then
 * 13 out of 19 on 2026-08-07.
 *
 * The trap underneath it was worse: the "stable global install" the fallback was repointed to,
 * `~/.npm-global/lib/node_modules/codesift-mcp`, was itself a `npm link` SYMLINK back to the dev
 * tree, and `~/.npm-global` shadowed the real prefix in PATH. So `npm i -g` reported success while
 * installing nothing, and a fix that looked right changed nothing at all.
 *
 * Hence: this does not read configuration and reason about it. It RESOLVES each entry to a real
 * file and checks the thing an agent would actually execute.
 *
 * Usage:  node scripts/check-agent-codesift.mjs [--json]
 * Exit 0 = everything an agent can open resolves; 1 = at least one project would fail.
 */
import { readFileSync, existsSync, realpathSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const JSON_OUT = process.argv.includes("--json");
// Overridable so the checker itself can be exercised against a fixture — a check nobody has ever
// seen fail is not a check.
const CLAUDE_JSON = process.env["CODESIFT_CHECK_CONFIG"] ?? join(homedir(), ".claude.json");

function fail(msg) {
  console.error(`check-agent-codesift: ${msg}`);
  process.exit(2);
}

let config;
try {
  config = JSON.parse(readFileSync(CLAUDE_JSON, "utf-8"));
} catch (err) {
  fail(`cannot read ${CLAUDE_JSON}: ${err.message}`);
}

/** What an agent in `dir` would actually launch: the project entry if any, else the global one. */
function effectiveEntry(dir) {
  const perProject = config.projects?.[dir]?.mcpServers?.codesift;
  if (perProject) return { scope: "project", entry: perProject };
  const global = config.mcpServers?.codesift;
  if (global) return { scope: "global", entry: global };
  return { scope: "none", entry: null };
}

/**
 * Resolve what would actually execute, following symlinks.
 *
 * Two shapes appear in these files and both matter. An MCP server entry is an absolute path. A HOOK
 * entry is a command line resolved through PATH (`codesift precheck-read --stdin`) — and hooks fail
 * SILENTLY, so a `codesift` that has fallen off PATH disables the read/bash prechecks with no error
 * anywhere. Checking only absolute paths would miss the quieter half.
 */
function resolveStdio(entry) {
  const raw = entry.args?.length ? entry.args[0] : entry.command;
  if (!raw) return { ok: false, why: "no command or args" };
  const argv0 = raw.trim().split(/\s+/)[0].replace(/^~/, homedir());

  if (argv0.includes("/")) {
    try {
      const real = realpathSync(argv0);
      if (!statSync(real).isFile()) return { ok: false, why: `${real} is not a file` };
      return { ok: true, real };
    } catch {
      return { ok: false, why: `${argv0} does not resolve to an existing file` };
    }
  }

  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, argv0);
    try {
      if (statSync(candidate).isFile()) return { ok: true, real: realpathSync(candidate) };
    } catch {
      /* next PATH entry */
    }
  }
  return { ok: false, why: `\`${argv0}\` is not on PATH — hooks using it fail silently` };
}

let daemonHealth = null;
function checkDaemon(url) {
  if (daemonHealth !== null) return daemonHealth; // one probe per run, not per project
  try {
    const origin = new URL(url).origin;
    const out = execFileSync("curl", ["-s", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", `${origin}/health`], {
      encoding: "utf-8",
    }).trim();
    daemonHealth = out === "200" ? { ok: true } : { ok: false, why: `daemon /health returned ${out}` };
  } catch (err) {
    daemonHealth = { ok: false, why: `daemon unreachable: ${err.message}` };
  }
  return daemonHealth;
}

const projectDirs = Object.keys(config.projects ?? {}).filter((d) => existsSync(d));
const results = [];

for (const dir of projectDirs) {
  const { scope, entry } = effectiveEntry(dir);
  if (!entry) {
    results.push({ dir, scope, transport: "-", ok: false, why: "no codesift entry at any scope" });
    continue;
  }
  if (entry.type === "http") {
    const health = checkDaemon(entry.url);
    // The URL pins a cwd. A stale one is not a hard failure — the daemon answers — but it means
    // this project's answers describe a directory that no longer exists, which is hint H19 as a
    // permanent condition rather than a transient one.
    let cwdNote = null;
    try {
      const cwd = decodeURIComponent(new URL(entry.url).searchParams.get("cwd") ?? "");
      if (cwd && !existsSync(cwd)) cwdNote = `pinned cwd missing: ${cwd}`;
      else if (cwd && cwd !== dir) cwdNote = `pinned cwd is ${cwd}, not this project`;
    } catch {
      cwdNote = "unparseable url";
    }
    results.push({ dir, scope, transport: "http", ok: health.ok, why: health.ok ? cwdNote : health.why });
  } else {
    const r = resolveStdio(entry);
    // The failure that started all this: a path that resolves INTO a working tree, which a build
    // deletes. Reachable right now, and broken the moment somebody runs `npm run build`.
    const note = r.ok && /\/DEV\/|\/projects\//.test(r.real)
      ? `resolves into a working tree (${r.real}) — a build there will break this`
      : null;
    results.push({ dir, scope, transport: "stdio", ok: r.ok, why: r.ok ? note : r.why });
  }
}

// The population that actually broke: directories with NO entry, which inherit the global one.
// Checking only `config.projects` would have reported all-clear throughout the outage, because the
// affected worktrees were never listed there. Every repo-looking directory under the dev roots is
// a candidate an agent can open tomorrow.
const listed = new Set(projectDirs);
const unlisted = [];
for (const root of [join(homedir(), "DEV"), join(homedir(), "projects")]) {
  if (!existsSync(root)) continue;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, ".git"))) continue;
    } catch {
      continue;
    }
    if (!listed.has(dir)) unlisted.push(dir);
  }
}

const globalEntry = config.mcpServers?.codesift ?? null;
let fallback;
if (!globalEntry) {
  fallback = { ok: false, why: "no global codesift entry — every unlisted directory has NO codesift" };
} else if (globalEntry.type === "http") {
  const h = checkDaemon(globalEntry.url);
  fallback = h.ok
    ? { ok: true, why: "global entry is http with a PINNED cwd — every unlisted directory resolves to that one repo (H19)" }
    : { ok: false, why: h.why };
} else {
  const r = resolveStdio(globalEntry);
  fallback = r.ok
    ? {
        ok: true,
        why: /\/DEV\/|\/projects\//.test(r.real)
          ? `resolves into a working tree (${r.real}) — a build there breaks codesift for ALL ${unlisted.length} unlisted repos`
          : null,
        real: r.real,
      }
    : { ok: false, why: r.why };
}
results.push({ dir: `(fallback for ${unlisted.length} unlisted repos)`, scope: "global", transport: globalEntry?.type ?? "-", ...fallback });

// EVERY client, not just Claude Code. The first version of this checker read ~/.claude.json alone
// and reported "0 broken" at a moment when Cursor, Gemini, Antigravity and Claude's settings.json
// all pointed at a path that had just been deleted — Codex's canary died and a human had to notice.
// Checking one client while four are down is the same mistake as checking the config instead of
// the file it resolves to.
const OTHER_CLIENTS = [
  join(homedir(), ".claude", "settings.json"),
  process.env["CODESIFT_CHECK_EXTRA_CLIENT"] ?? join(homedir(), ".codex", "config.toml"),
  join(homedir(), ".cursor", "mcp.json"),
  join(homedir(), ".gemini", "settings.json"),
  join(homedir(), ".gemini", "antigravity", "mcp_config.json"),
];

for (const file of OTHER_CLIENTS) {
  if (!existsSync(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    results.push({ dir: file, scope: "client", transport: "-", ok: false, why: `unreadable: ${err.message}` });
    continue;
  }
  // Deliberately textual, including for TOML: the question is "does the command this client would
  // run exist", and every client spells that as a path in the file. A per-format parser would add
  // three dependencies to answer a question a path extraction already answers.
  // ONLY the value of a `command` key — TOML `command = "…"` or JSON `"command": "…"`. An earlier
  // version matched any quoted string containing "codesift", which happily flagged Codex's
  // `[projects."/Users/greglas/DEV/codesift-mcp"]` section header as a missing executable. A
  // checker that cries wolf about a directory is a checker people stop reading.
  const cmds = new Set();
  for (const m of text.matchAll(/(?:"command"\s*:|(?:^|\n)\s*command\s*=)\s*"([^"\n]+)"/g)) {
    const v = m[1];
    if (v && v.includes("codesift")) cmds.add(v);
  }
  if (cmds.size === 0) {
    results.push({ dir: file, scope: "client", transport: "-", ok: true, why: "no codesift path (http or absent)" });
    continue;
  }
  for (const cmd of cmds) {
    const r = resolveStdio({ command: cmd });
    const note = r.ok && /\/DEV\/|\/projects\//.test(r.real)
      ? `resolves into a working tree (${r.real}) — a build there will break this client`
      : null;
    results.push({ dir: `${file} -> ${cmd}`, scope: "client", transport: "stdio", ok: r.ok, why: r.ok ? note : r.why });
  }
}

const broken = results.filter((r) => !r.ok);
const warned = results.filter((r) => r.ok && r.why);

if (JSON_OUT) {
  console.log(JSON.stringify({ checked: results.length, broken, warned, results }, null, 2));
} else {
  console.log(`projects checked: ${results.length}`);
  const byTransport = results.reduce((a, r) => ((a[r.transport] = (a[r.transport] ?? 0) + 1), a), {});
  console.log(`transports: ${JSON.stringify(byTransport)}`);
  console.log(`BROKEN: ${broken.length}   warnings: ${warned.length}`);
  for (const r of broken) console.log(`  BROKEN  ${r.transport.padEnd(5)} ${r.dir}\n            ${r.why}`);
  for (const r of warned.slice(0, 15)) console.log(`  warn    ${r.transport.padEnd(5)} ${r.dir}\n            ${r.why}`);
  if (warned.length > 15) console.log(`  … and ${warned.length - 15} more warnings`);
}

process.exit(broken.length > 0 ? 1 : 0);

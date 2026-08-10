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
import {
  accessSync,
  constants,
  readFileSync,
  existsSync,
  realpathSync,
  statSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
function resolveStdio(entry, baseDir = process.cwd()) {
  let explicitCommand = entry.command?.trim();
  const rawCommand = explicitCommand
    || entry.args?.find((arg) => typeof arg === "string" && !arg.startsWith("-"))?.trim();
  if (!rawCommand) return { ok: false, why: "no command" };
  if (!explicitCommand) {
    if (new Set(["node", "nodejs", "bun", "deno"]).has(rawCommand)) {
      explicitCommand = rawCommand;
      const commandIndex = entry.args.indexOf(rawCommand);
      entry = { ...entry, command: rawCommand, args: entry.args.slice(commandIndex + 1) };
    } else {
      const candidate = rawCommand.replace(/^~/, homedir());
      return resolveDirectFile(candidate.startsWith("/") ? candidate : resolve(baseDir, candidate), false);
    }
  }
  const argv0 = rawCommand.split(/\s+/)[0].replace(/^~/, homedir());

  function resolveDirectFile(candidate, executable) {
    try {
      const real = realpathSync(candidate);
      if (!statSync(real).isFile()) return { ok: false, why: `${real} is not a file` };
      if (executable) accessSync(real, constants.X_OK);
      return { ok: true, real };
    } catch {
      return {
        ok: false,
        why: executable
          ? `${candidate} does not resolve to an executable file`
          : `${candidate} does not resolve to an existing file`,
      };
    }
  }
  const resolveFile = resolveDirectFile;

  if (argv0.includes("/")) {
    const commandPath = argv0.startsWith("/") ? argv0 : resolve(baseDir, argv0);
    const command = resolveFile(commandPath, true);
    if (!command.ok) return command;
    return resolveInterpreterTarget(entry, rawCommand, command, resolveFile, baseDir);
  }

  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, argv0);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return resolveInterpreterTarget(entry, rawCommand, { ok: true, real: realpathSync(candidate) }, resolveFile, baseDir);
    } catch {
      /* next PATH entry */
    }
  }
  return { ok: false, why: `\`${argv0}\` is not on PATH — hooks using it fail silently` };
}

function resolveInterpreterTarget(entry, rawCommand, command, resolveFile, baseDir) {
  const executable = command.real.split("/").pop();
  const interpreters = new Set(["node", "nodejs", "bun", "deno"]);
  if (!interpreters.has(executable)) return command;
  const argv = [...rawCommand.split(/\s+/).slice(1), ...(entry.args ?? [])];
  const evalFlags = new Set(["-e", "--eval", "-p", "--print"]);
  const flagsWithValue = new Set([
    "-r",
    "--require",
    "--loader",
    "--import",
    "--conditions",
    "--input-type",
    "--experimental-sea-config",
  ]);
  let target;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== "string") continue;
    if (evalFlags.has(arg)) return command; // inline source, no script path
    if (flagsWithValue.has(arg)) { i++; continue; }
    if (arg.startsWith("-")) continue;
    if (interpreters.has(arg)) continue;
    if ((executable === "bun" || executable === "deno") && arg === "run") continue;
    target = arg;
    break;
  }
  if (!target) return command;
  const expanded = target.replace(/^~/, homedir());
  return resolveFile(expanded.startsWith("/") ? expanded : resolve(baseDir, expanded), false);
}

const daemonHealth = new Map();
function checkDaemon(url) {
  let origin;
  try {
    origin = new URL(url).origin;
    const cached = daemonHealth.get(origin);
    if (cached) return cached;
    const out = execFileSync("curl", ["-s", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", `${origin}/health`], {
      encoding: "utf-8",
    }).trim();
    const result = out === "200" ? { ok: true } : { ok: false, why: `daemon /health returned ${out}` };
    daemonHealth.set(origin, result);
    return result;
  } catch (err) {
    const result = { ok: false, why: `daemon unreachable: ${err.message}` };
    if (origin) daemonHealth.set(origin, result);
    return result;
  }
}

const projectDirs = Object.keys(config.projects ?? {});
const results = [];

for (const dir of projectDirs) {
  if (!existsSync(dir)) {
    results.push({ dir, scope: "project", transport: "-", ok: false, why: "project path missing" });
    continue;
  }
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
      const cwd = new URL(entry.url).searchParams.get("cwd") ?? "";
      if (cwd && !existsSync(cwd)) cwdNote = `pinned cwd missing: ${cwd}`;
      else if (cwd && cwd !== dir) cwdNote = `pinned cwd is ${cwd}, not this project`;
    } catch {
      cwdNote = "unparseable url";
    }
    results.push({ dir, scope, transport: "http", ok: health.ok, why: health.ok ? cwdNote : health.why });
  } else {
    const r = resolveStdio(entry, dir);
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
function discoverRepos(root, depth = 0) {
  if (depth > 2 || !existsSync(root)) return;
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      if (existsSync(join(dir, ".git"))) {
        if (!listed.has(dir)) unlisted.push(dir);
        continue;
      }
      discoverRepos(dir, depth + 1);
    } catch {
      /* unreadable subtree */
    }
  }
}
for (const root of [join(homedir(), "DEV"), join(homedir(), "projects")]) {
  discoverRepos(root);
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
  const r = resolveStdio(globalEntry, homedir());
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
  const argPaths = new Set();
  for (const m of text.matchAll(/(?:"command"\s*:|(?:^|\n)\s*command\s*=)\s*"([^"\n]+)"/g)) {
    const v = m[1];
    if (v && v.includes("codesift")) cmds.add(v);
  }
  // Node-based MCP entries keep the actual program in `args`, not `command`.
  // Only path-like values are actionable here; package names used through npx
  // are validated by resolving the npx executable itself.
  for (const m of text.matchAll(/(?:(?:"args"\s*:)|(?:(?:^|\n)\s*args\s*=))\s*\[([^\]]*)\]/g)) {
    for (const value of m[1].matchAll(/"([^"\n]+)"/g)) {
      const arg = value[1];
      if (arg?.includes("codesift") && arg.includes("/")) argPaths.add(arg);
    }
  }
  if (cmds.size === 0 && argPaths.size === 0) {
    results.push({ dir: file, scope: "client", transport: "-", ok: true, why: "no codesift path (http or absent)" });
    continue;
  }
  for (const cmd of cmds) {
    const r = resolveStdio({ command: cmd }, dirname(file));
    const note = r.ok && /\/DEV\/|\/projects\//.test(r.real)
      ? `resolves into a working tree (${r.real}) — a build there will break this client`
      : null;
    results.push({ dir: `${file} -> ${cmd}`, scope: "client", transport: "stdio", ok: r.ok, why: r.ok ? note : r.why });
  }
  for (const argPath of argPaths) {
    const r = resolveStdio({ command: process.execPath, args: [argPath] }, dirname(file));
    const note = r.ok && /\/DEV\/|\/projects\//.test(r.real)
      ? `resolves into a working tree (${r.real}) — a build there will break this client`
      : null;
    results.push({
      dir: `${file} -> ${argPath}`,
      scope: "client",
      transport: "stdio",
      ok: r.ok,
      why: r.ok ? note : r.why,
    });
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

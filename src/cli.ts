#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { parseArgs, getBoolFlag, die } from "./cli/args.js";
import { MAIN_HELP, COMMAND_HELP } from "./cli/help.js";
import { COMMAND_MAP } from "./cli/commands.js";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

async function getVersion(): Promise<string> {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    // Try dist/../package.json first, then src/../package.json
    for (const base of [join(thisDir, ".."), join(thisDir, "..", "..")]) {
      try {
        const raw = await readFile(join(base, "package.json"), "utf-8");
        const pkg: unknown = JSON.parse(raw);
        if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
          return String((pkg as Record<string, unknown>)["version"]);
        }
      } catch {
        continue;
      }
    }
  } catch {
    // fall through
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

// Commands that intentionally keep the process alive (file watcher). Every
// other command is one-shot and must force-exit afterwards: the local embedding
// provider (onnxruntime workers) and other lazy singletons hold open handles
// that otherwise keep the event loop alive, leaving `codesift wiki-generate`
// (and any hook-spawned regeneration) hanging as a zombie process.
let keepProcessAlive = false;

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const { positional, flags } = parseArgs(rawArgs);

  const command = positional[0];
  const commandArgs = positional.slice(1);

  // Handle top-level flags
  if (getBoolFlag(flags, "version") || command === "--version") {
    const version = await getVersion();
    process.stdout.write(`codesift ${version}\n`);
    return;
  }

  if (getBoolFlag(flags, "help") && !command) {
    process.stdout.write(MAIN_HELP);
    return;
  }

  if (!command) {
    process.stdout.write(MAIN_HELP);
    return;
  }

  // Per-command help
  if (getBoolFlag(flags, "help")) {
    const help = COMMAND_HELP[command];
    if (help) {
      process.stdout.write(help + "\n");
    } else {
      die(`Unknown command: ${command}. Run 'codesift --help' for available commands.`);
    }
    return;
  }

  // Initialize config before running any command
  loadConfig();

  const handler = COMMAND_MAP[command];
  if (!handler) {
    die(`Unknown command: ${command}. Run 'codesift --help' for available commands.`);
  }

  // `index` / `index-repo` keep a file watcher alive unless --no-watch is set.
  if ((command === "index" || command === "index-repo") && getBoolFlag(flags, "no-watch") !== true) {
    keepProcessAlive = true;
  }

  // `serve` is a long-lived daemon — never force-exit it.
  if (command === "serve") {
    keepProcessAlive = true;
  }

  await handler(commandArgs, flags);
}

main()
  .then(async () => {
    // Force a clean exit for one-shot commands so leaked handles (embedding
    // workers, etc.) can't keep the process hanging. Watch mode opts out.
    // Drain stdout+stderr first via empty-write callbacks so piped output
    // (`codesift search ... > out.json`) doesn't get truncated when there's
    // pending data in the buffer.
    if (keepProcessAlive) return;
    try {
      const { disposeLocalPipelines } = await import("./search/semantic.js");
      await disposeLocalPipelines();
    } catch { /* disposal is best-effort — never block exit on it */ }

    // Let the process exit NATURALLY — do not call process.exit()/reallyExit().
    //
    // With an onnxruntime session loaded, a forced exit aborts during native
    // teardown: `libc++abi ... mutex lock failed: Invalid argument`, exit 134.
    // Measured on 2,400 embeddings, all three variants:
    //   natural exit  → 0     (clean)
    //   process.exit  → 134   (abort)
    //   reallyExit    → 134   (abort)
    // The abort happens after every file is written, so no data is lost — but
    // 134 makes every caller believe the command failed.
    //
    // ORT does not hold the event loop open, so natural exit terminates
    // promptly. The unref'd timer is a backstop for some OTHER leaked handle;
    // being unref'd it cannot keep the process alive on its own.
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 10_000).unref();
  })
  .catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});

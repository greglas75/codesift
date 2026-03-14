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
  await handler(commandArgs, flags);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});

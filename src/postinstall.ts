/**
 * The package's postinstall, as a Node file rather than a shell line.
 *
 * It used to be `node ./dist/cli.js setup all 2>/dev/null && echo … || echo …; node … 2>/dev/null || true`.
 * npm runs lifecycle scripts through `cmd.exe` on Windows, where `/dev/null` does not exist ("The
 * system cannot find the path specified") and `;` is not a separator — so the script exited 1 and npm
 * ROLLED BACK the whole `npm install -g`, leaving the old version in place with no clear reason.
 * Reported from a Windows install; the only way out was `--ignore-scripts`.
 *
 * Every path ends at exit 0: a configuration step must never be able to fail the install it follows.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OK = "\n  ✨ CodeSift MCP installed and configured for all platforms.\n"
  + "  ⚠️  Restart your AI client (Cmd+Q for Claude Code) to load new MCP server.\n";
const FALLBACK = "\n  ✨ CodeSift MCP installed. Run: codesift setup all\n";

try {
  const here = dirname(fileURLToPath(import.meta.url));
  // stderr is dropped as before; stdout stays visible so setup's own summary still shows.
  const setup = spawnSync(process.execPath, [join(here, "cli.js"), "setup", "all"], {
    stdio: ["ignore", "inherit", "ignore"],
  });
  console.log(setup.status === 0 ? OK : FALLBACK);
  spawnSync(process.execPath, [join(here, "install-check.js")], { stdio: ["ignore", "inherit", "inherit"] });
} catch {
  console.log(FALLBACK);
}
process.exit(0);

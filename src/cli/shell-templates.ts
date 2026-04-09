// ---------------------------------------------------------------------------
// Cline hooks — shell scripts for file-based hook system
// ---------------------------------------------------------------------------
// Cline uses file-based hooks (shell scripts). Each hook is a .sh file that
// receives JSON on stdin and outputs JSON on stdout.
// We create wrapper scripts that delegate to codesift CLI commands.
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

export function getClineHooksDirCandidates(): string[] {
  return [
    join(homedir(), "Documents", "Cline", "Hooks"),       // macOS default
    join(homedir(), ".cline", "hooks"),                     // Linux alternative
  ];
}

export const CLINE_HOOK_SCRIPTS: Record<string, string> = {
  "PreToolUse.sh": `#!/bin/bash
# CodeSift: redirect large file reads to CodeSift tools
INPUT=$(cat)
TOOL=$(echo "$INPUT" | grep -o '"tool":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$TOOL" = "Read" ] || [ "$TOOL" = "read_file" ]; then
  export HOOK_TOOL_INPUT="$INPUT"
  OUTPUT=$(codesift precheck-read 2>/dev/null)
  if [ $? -eq 2 ]; then
    echo "{\\"cancel\\": true, \\"contextModification\\": $(echo "$OUTPUT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')}"
    exit 0
  fi
fi
echo "{\\"cancel\\": false}"
`,
  "PostToolUse.sh": `#!/bin/bash
# CodeSift: auto-reindex files after edit/write
INPUT=$(cat)
TOOL=$(echo "$INPUT" | grep -o '"tool":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$TOOL" = "Write" ] || [ "$TOOL" = "Edit" ] || [ "$TOOL" = "write_file" ] || [ "$TOOL" = "replace" ]; then
  export HOOK_TOOL_INPUT="$INPUT"
  codesift postindex-file >/dev/null 2>&1
fi
echo "{\\"cancel\\": false}"
`,
  "PreCompact.sh": `#!/bin/bash
# CodeSift: inject session snapshot before context compaction
INPUT=$(cat)
export HOOK_TOOL_INPUT="$INPUT"
SNAPSHOT=$(codesift precompact-snapshot 2>/dev/null)
if [ -n "$SNAPSHOT" ]; then
  echo "{\\"cancel\\": false, \\"contextModification\\": $(echo "$SNAPSHOT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')}"
else
  echo "{\\"cancel\\": false}"
fi
`,
};

export async function setupClineHooks(): Promise<void> {
  // Find or create hooks directory
  let hooksDir: string | undefined;
  for (const candidate of getClineHooksDirCandidates()) {
    if (existsSync(candidate)) {
      hooksDir = candidate;
      break;
    }
  }
  if (!hooksDir) {
    // Create default directory
    hooksDir = getClineHooksDirCandidates()[0]!;
    await mkdir(hooksDir, { recursive: true });
  }

  for (const [filename, content] of Object.entries(CLINE_HOOK_SCRIPTS)) {
    const hookPath = join(hooksDir, filename);

    if (existsSync(hookPath)) {
      // Don't overwrite existing hooks — they may contain user customizations
      const existing = await readFile(hookPath, "utf-8");
      if (existing.includes("codesift")) continue; // Already has our hooks
      // Append our section
      const marker = "\n\n# --- CodeSift hooks (auto-installed) ---\n";
      if (!existing.includes("CodeSift")) {
        await writeFile(hookPath, existing.trimEnd() + marker + content, "utf-8");
      }
      continue;
    }

    await writeFile(hookPath, content, { mode: 0o755 });
  }
}

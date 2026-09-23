import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseHookInput, readRawInput } from "./input.js";

export async function handlePrecompactSnapshot(): Promise<void> {
  try {
    // First, before any early exit: compaction is about to drop old tool results, so source the
    // server answered with a "shown earlier" pointer must be resent from now on.
    const { touchCompactionMarker } = await import("../../server-helpers/shown-source.js");
    touchCompactionMarker();

    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }

    const { sessionId } = parseHookInput(raw);

    if (!sessionId || !/^[a-f0-9-]+$/i.test(sessionId)) {
      process.exit(0);
      return;
    }

    const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
    const sidecarPath = join(dataDir, `session-${sessionId}.json`);

    let sidecarData: Record<string, unknown>;
    try {
      const content = readFileSync(sidecarPath, "utf-8");
      sidecarData = JSON.parse(content) as Record<string, unknown>;
    } catch {
      process.exit(0);
      return;
    }

    const { deserializeState, formatSnapshot } = await import("../../storage/session-state.js");
    const sessionState = deserializeState(sidecarData);
    const snapshot = formatSnapshot(sessionState);

    if (snapshot) {
      process.stdout.write(snapshot, () => process.exit(0));
      return;
    }

    process.exit(0);
  } catch {
    process.exit(0);
  }
}

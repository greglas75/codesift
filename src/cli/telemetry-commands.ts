// `codesift telemetry <show|on|off|full|status>` — transparency + opt-out UI
// (spec §4). `show` prints the EXACT Level-1 payload that would be sent.
import {
  resolveTelemetryLevel,
  telemetrySource,
  writeStoredTelemetryLevel,
} from "../storage/telemetry/config.js";
import { buildCurrentLevel1Payload } from "../storage/telemetry/payload.js";
import { getAnonIdPath } from "../storage/telemetry/anon-id.js";

function printStatus(): void {
  const { level, reason } = telemetrySource();
  console.log(`telemetry level: ${level}  (${reason})`);
  console.log("");
  console.log("  off   — send nothing");
  console.log("  anon  — anonymous aggregates only (default; see: codesift telemetry show)");
  console.log("  full  — full local usage entries (opt-in; queries/paths included)");
  console.log("");
  console.log("opt out:  CODESIFT_TELEMETRY=off   (or DO_NOT_TRACK=1, or `codesift telemetry off`)");
  console.log(`anon id:  ${getAnonIdPath()}`);
}

export async function handleTelemetry(args: string[]): Promise<void> {
  const sub = (args[0] ?? "status").toLowerCase();

  switch (sub) {
    case "show": {
      const payload = await buildCurrentLevel1Payload(Date.now());
      console.log(
        "# Exact anonymous (Level-1) payload that would be sent — allowlist only,\n" +
        "# no queries, paths, repo/file/symbol names, code, hostname or IP.\n",
      );
      console.log(JSON.stringify(payload, null, 2));
      console.log(`\n(current level: ${resolveTelemetryLevel()})`);
      return;
    }
    case "off":
      writeStoredTelemetryLevel("off");
      console.log("telemetry disabled (config.json telemetry.level=off).");
      return;
    case "on":
    case "anon":
      writeStoredTelemetryLevel("anon");
      console.log("telemetry set to anon (anonymous aggregates).");
      return;
    case "full":
      writeStoredTelemetryLevel("full");
      console.log("telemetry set to full (opt-in — full local usage entries will be sent).");
      return;
    case "status":
      printStatus();
      return;
    default:
      console.error(`unknown: telemetry ${sub}. Use: show | on | off | full | status`);
      process.exitCode = 1;
      return;
  }
}

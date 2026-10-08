/**
 * Index worker process: runs indexFolder for the daemon, off the daemon's request-serving thread.
 *
 * See src/tools/index-tools/out-of-process.ts for why it exists and what was measured. The contract
 * mirrors embed-child.ts: the work lands in the on-disk index (SQLite, WAL), and the parent learns
 * the outcome from ONE marker line on stdout — never from the exit code, which an orphan or
 * root-gone guard sets to 0 without having finished anything.
 *
 * Argument: a JSON `IndexChildRequest`. Output: `INDEX_CHILD_RESULT_MARKER{result, report}` on
 * success, `INDEX_CHILD_ERROR_MARKER<message>` when indexFolder threw.
 */
import { INDEX_CHILD_ERROR_MARKER, INDEX_CHILD_RESULT_MARKER } from "./embed-child-marker.js";
import { exitWhenOrphaned, exitWhenRootGone } from "./orphan-guard.js";
import type { IndexChildRequest, IndexFolderReport } from "../tools/index-tools/out-of-process.js";

function writeLine(line: string): Promise<void> {
  return new Promise((resolve) => {
    // The callback fires once the data is handed to the pipe; exiting before it would lose the one
    // line the parent is waiting for on platforms where pipe writes are asynchronous (macOS).
    process.stdout.write(`${line}\n`, () => resolve());
  });
}

async function main(): Promise<number> {
  exitWhenOrphaned();
  const raw = process.argv[2];
  let request: IndexChildRequest;
  try {
    request = JSON.parse(raw ?? "") as IndexChildRequest;
    if (!request || typeof request.path !== "string") throw new Error("missing path");
    // The options are spread into indexFolder; anything but a plain object is a broken caller.
    if (request.options !== undefined && (typeof request.options !== "object" || request.options === null || Array.isArray(request.options))) {
      throw new Error("options must be an object");
    }
  } catch (err) {
    await writeLine(`${INDEX_CHILD_ERROR_MARKER}index-child: bad request (${(err as Error).message})`);
    return 2;
  }
  exitWhenRootGone(request.path);

  const { indexFolder } = await import("../tools/index-tools/folder-indexer.js");
  const report: IndexFolderReport = {};
  try {
    const result = await indexFolder(request.path, {
      ...request.options,
      // The watcher belongs to the long-lived parent; one here would die with this process.
      watch: false,
      report,
    });
    await writeLine(`${INDEX_CHILD_RESULT_MARKER}${JSON.stringify({ result, report })}`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // One line: the parent reads line-wise, and a stack trace's newlines would split the message.
    await writeLine(`${INDEX_CHILD_ERROR_MARKER}${message.replace(/\n/g, " ")}`);
    return 1;
  }
}

// Forced exit is safe here and necessary: this process never loads onnxruntime (embedding is
// suppressed via CODESIFT_EMBED_OUT_OF_PROCESS=1), and the parser pool's workers would otherwise
// keep it alive after its only job is done.
main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`index-child: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);

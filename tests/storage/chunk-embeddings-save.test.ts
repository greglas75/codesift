import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveChunkEmbeddings, loadChunkEmbeddings } from "../../src/storage/chunk-store.js";

/**
 * saveChunkEmbeddings used to build one `lines.join("\n")` string for the whole
 * map. Past V8's max string length (~512 MB of ndjson) that throws
 * `RangeError: Invalid string length`, and the caller's non-fatal catch turned
 * it into a silent "exit 0, no chunk file" — a repo with enough chunks
 * (TGMQuotas, ~27K) got symbol-level semantic only, no chunk-level, with no
 * error surfaced. It now streams, like saveEmbeddings.
 */
describe("saveChunkEmbeddings — streamed, round-trips", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "codesift-chunkemb-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes and reads back many chunk vectors without building one giant string", async () => {
    const p = join(dir, "x.chunk-embeddings.ndjson");
    const m = new Map<string, Float32Array>();
    // Enough entries to exercise the streaming path and backpressure/drain.
    for (let i = 0; i < 5000; i++) {
      m.set(`chunk-${i}`, new Float32Array(768).fill(i % 7 * 0.01));
    }
    await saveChunkEmbeddings(p, m);
    expect(existsSync(p)).toBe(true);

    const back = await loadChunkEmbeddings(p);
    expect(back).not.toBeNull();
    expect(back!.size).toBe(5000);
    expect(back!.get("chunk-4999")!.length).toBe(768);
  });

  it("leaves no .tmp file behind on success", async () => {
    const p = join(dir, "y.chunk-embeddings.ndjson");
    await saveChunkEmbeddings(p, new Map([["a", new Float32Array(768)]]));
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).some((f) => f.includes(".tmp."))).toBe(false);
  });
});

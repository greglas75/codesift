import { describe, expect, it } from "vitest";
import { scanEmbeddingMarker } from "../../src/cli/commands-index.js";

describe("embedding child success marker", () => {
  it("detects a marker split across stdout chunks", () => {
    const marker = "CODESIFT_EMBED_OK";
    const first = scanEmbeddingMarker("", "progress\nCODESIFT_EM", marker);
    expect(first.sawMarker).toBe(false);

    const second = scanEmbeddingMarker(first.tail, "BED_OK\n", marker);
    expect(second.sawMarker).toBe(true);
  });
});

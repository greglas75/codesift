// A successful install that quietly removed a feature is the worst shape a failure can take: there
// is no exit code to notice, no log to read, and the first symptom arrives much later somewhere
// unrelated. onnxruntime-node's install step downloads a CUDA/GPU build on linux/x64 even with no
// GPU; when it fails npm drops it AND @huggingface/transformers, then exits 0 (measured on
// burst-i9 2026-08-12: 238 packages -> 207, `Error: socket hang up`).
//
// These tests pin the two things that make the message worth printing: it fires only where the
// download is actually attempted, and it names the flag — because on linux/x64 the obvious advice
// ("install the package") is advice to repeat the step that just failed.
import { describe, it, expect } from "vitest";
import { embeddingInstallNotice } from "../../src/install-check.js";
import { localEmbeddingRemedy } from "../../src/search/optional-transformers.js";

describe("embeddingInstallNotice", () => {
  it("fires on linux/x64 when the package is gone", () => {
    const notice = embeddingInstallNotice({
      platform: "linux",
      arch: "x64",
      transformersResolved: false,
    });
    expect(notice).toBeTruthy();
    // The flag IS the fix; a notice without it sends the user back into the same failure.
    expect(notice).toContain("--onnxruntime-node-install-cuda=skip");
    // Name the blast radius, or the reader assumes CodeSift is broken rather than one feature.
    expect(notice).toMatch(/only semantic search/i);
  });

  it("stays silent when the package is present", () => {
    expect(
      embeddingInstallNotice({ platform: "linux", arch: "x64", transformersResolved: true }),
    ).toBeNull();
  });

  it.each([
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["win32", "x64"],
    ["linux", "arm64"],
  ])("stays silent on %s/%s, where the CUDA download is never attempted", (platform, arch) => {
    // onnxruntime's own guard is `IS_LINUX_X64`. Warning anywhere else would be a false alarm, and
    // a warning that cries wolf is how real ones get ignored.
    expect(embeddingInstallNotice({ platform, arch, transformersResolved: false })).toBeNull();
  });
});

describe("localEmbeddingRemedy", () => {
  it("tells linux/x64 to skip the CUDA download rather than to retry the install", () => {
    const remedy = localEmbeddingRemedy("linux", "x64");
    expect(remedy).toContain("--onnxruntime-node-install-cuda=skip");
    // The old message said "Install @huggingface/transformers" on every platform. On linux/x64 a
    // plain install re-runs the same postinstall and drops the package again, so that sentence was
    // instructions to reproduce the bug.
    expect(remedy).not.toMatch(/^Install @huggingface\/transformers/);
  });

  it("keeps the plain advice where the plain advice works", () => {
    expect(localEmbeddingRemedy("darwin", "arm64")).toContain("Install @huggingface/transformers");
  });

  it("always offers the remote provider as the way out", () => {
    for (const [p, a] of [["linux", "x64"], ["darwin", "arm64"]] as const) {
      expect(localEmbeddingRemedy(p, a)).toContain("CODESIFT_VOYAGE_API_KEY");
    }
  });
});

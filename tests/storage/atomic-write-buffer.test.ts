import { atomicWriteBuffer } from "../../src/storage/_shared.js";
import { mkdtemp, mkdir, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("atomicWriteBuffer", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-atomic-write-buffer-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // Test 1: writes a Buffer and reads it back byte-identical (binary safety)
  it("writes a Buffer and reads it back byte-identical (non-UTF8 bytes)", async () => {
    const targetPath = join(tmpDir, "binary.bin");
    const buf = Buffer.from([0x00, 0xff, 0x1f, 0x8b]);

    await atomicWriteBuffer(targetPath, buf);
    const readBack = await readFile(targetPath);

    expect(readBack.equals(buf)).toBe(true);
  });

  // Test 2: two concurrent writers to the same target both settle without ENOENT,
  // and the final content is exactly one writer's complete payload (never
  // interleaved or truncated).
  it("settles two concurrent writers to the same target with one complete payload (never interleaved)", async () => {
    const targetPath = join(tmpDir, "concurrent.bin");
    const payloadA = Buffer.alloc(50_000, 0xaa);
    const payloadB = Buffer.alloc(50_000, 0xbb);

    const results = await Promise.allSettled([
      atomicWriteBuffer(targetPath, payloadA),
      atomicWriteBuffer(targetPath, payloadB),
    ]);

    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }

    const finalContent = await readFile(targetPath);
    const matchesA = finalContent.equals(payloadA);
    const matchesB = finalContent.equals(payloadB);
    expect(matchesA || matchesB).toBe(true);
  });

  // Test 3: a failed write (target path collides with an existing directory,
  // so the rename step fails) leaves no orphaned *.tmp* file behind.
  it("leaves no orphaned *.tmp* file in the parent dir when the write fails", async () => {
    const targetPath = join(tmpDir, "collide.bin");
    await mkdir(targetPath); // targetPath exists as a directory -> rename() will fail

    const buf = Buffer.from([0x01, 0x02, 0x03]);
    await expect(atomicWriteBuffer(targetPath, buf)).rejects.toThrow();

    const entries = await readdir(tmpDir);
    const tmpResidues = entries.filter((e) => e.includes(".tmp"));
    expect(tmpResidues).toHaveLength(0);
  });
});

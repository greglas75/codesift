import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../../../src/config.js";
import { indexFolder } from "../../../src/tools/index-tools.js";

export interface ConstantResolutionFixture {
  cleanup(): Promise<void>;
  root: string;
  write(files: Record<string, string>): Promise<string>;
}

export async function createConstantResolutionFixture(): Promise<ConstantResolutionFixture> {
  const tmpDir = await mkdtemp(join(tmpdir(), "codesift-constant-resolution-"));
  const fixtureDir = join(tmpDir, "constant-resolution-project");
  await mkdir(fixtureDir, { recursive: true });

  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();

  return {
    root: fixtureDir,
    async cleanup(): Promise<void> {
      delete process.env["CODESIFT_DATA_DIR"];
      resetConfigCache();
      await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
    async write(files: Record<string, string>): Promise<string> {
      for (const [relativePath, content] of Object.entries(files)) {
        const absPath = join(fixtureDir, relativePath);
        await mkdir(join(absPath, ".."), { recursive: true });
        await writeFile(absPath, content);
      }
      return (await indexFolder(fixtureDir, { watch: false })).repo;
    },
  };
}

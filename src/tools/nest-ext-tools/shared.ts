import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "../index-tools.js";
import type { NestToolError } from "../nest-tools.js";

export type NestCodeIndex = NonNullable<Awaited<ReturnType<typeof getCodeIndex>>>;

export async function requireNestCodeIndex(repo: string): Promise<NestCodeIndex> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  return index;
}

export async function readNestSource(
  index: NestCodeIndex,
  file: string,
  errors: NestToolError[],
): Promise<string | undefined> {
  try {
    return await readFile(join(index.root, file), "utf-8");
  } catch (err) {
    errors.push({
      file,
      reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return undefined;
  }
}

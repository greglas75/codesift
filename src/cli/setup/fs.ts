import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

export async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf-8");
  if (raw.trim() === "") {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse " + path + " as JSON. Fix the file and retry.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected an object in " + path + ", got " + typeof parsed + ".");
  }
  return parsed as Record<string, unknown>;
}

export async function writeJsonFile(path: string, data: Record<string, unknown>): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function resolvePackageFile(relativePath: string): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  for (const base of [join(thisDir, "..", ".."), join(thisDir, "..", "..", "..")]) {
    const candidate = join(base, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Could not resolve package file: " + relativePath);
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

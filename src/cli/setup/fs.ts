import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_ONLY_MODE, writeOwnerOnlyFile } from "../owner-only-file.js";

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

/**
 * Owner-only. These files can carry a daemon bearer token, and the whole point of the
 * shared-daemon feature is that the host is shared — so the default umask (commonly 0644,
 * group- and world-readable) hands every other local account a credential that grants
 * read access to every indexed repository on that daemon.
 *
 * The mode is enforced by `owner-only-file.ts`, which also decides what to do when it
 * cannot be enforced — see the header there for why that is not best-effort.
 */
export const SECRET_FILE_MODE = OWNER_ONLY_MODE;

/** Write a text config that may embed a bearer token, owner-readable only. */
export async function writeSecretFile(path: string, content: string): Promise<void> {
  await writeOwnerOnlyFile(path, content);
}

export async function writeJsonFile(path: string, data: Record<string, unknown>): Promise<void> {
  await writeOwnerOnlyFile(path, JSON.stringify(data, null, 2) + "\n");
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

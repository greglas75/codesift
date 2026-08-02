import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile , chmod } from "node:fs/promises";
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

/**
 * Owner-only. These files can carry a daemon bearer token, and the whole point of the
 * shared-daemon feature is that the host is shared — so the default umask (commonly 0644,
 * group- and world-readable) hands every other local account a credential that grants
 * read access to every indexed repository on that daemon.
 *
 * `mode` only applies when the file is CREATED, so an existing config keeps its old
 * permissions; the explicit chmod below covers the rewrite case.
 */
export const SECRET_FILE_MODE = 0o600;

/** Write a text config that may embed a bearer token, owner-readable only. */
export async function writeSecretFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf-8", mode: SECRET_FILE_MODE });
  await chmod(path, SECRET_FILE_MODE).catch(() => {
    /* best-effort: a filesystem without POSIX modes must not fail the setup */
  });
}

export async function writeJsonFile(path: string, data: Record<string, unknown>): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: SECRET_FILE_MODE });
  await chmod(path, SECRET_FILE_MODE).catch(() => {
    /* best-effort: a filesystem without POSIX modes must not fail the setup */
  });
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

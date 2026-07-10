import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  parseDependencyMajor,
  type LockfileAggregate,
  type PackageManager,
} from "./dependency-audit-types.js";

const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error
      && ((error as { code?: unknown }).code === "ENOENT"
        || (error as { code?: unknown }).code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

async function resolveLockfileName(
  workspace: string,
  packageManager: PackageManager,
): Promise<string | null> {
  switch (packageManager) {
    case "npm": return "package-lock.json";
    case "pnpm": return "pnpm-lock.yaml";
    case "yarn": return "yarn.lock";
    case "bun":
      if (await fileExists(join(workspace, "bun.lockb"))) return "bun.lockb";
      return "bun.lock";
    default: return null;
  }
}

async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const metadata = await stat(path);
  if (metadata.size > maxBytes) throw new Error("dependency file exceeds size limit");
  return readFile(path, "utf-8");
}

function versionSatisfiesManifest(manifestRange: string, installed: string): boolean {
  const cleanedRange = manifestRange.replace(/^[\^~>=<v\s]+/, "").trim();
  const manifestMajor = parseDependencyMajor(cleanedRange);
  const installedMajor = parseDependencyMajor(installed);
  return manifestMajor === null || installedMajor === null || manifestMajor === installedMajor;
}

function collectDeclaredDependencies(manifest: Record<string, unknown>): Record<string, string> {
  const declared: Record<string, string> = {};
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const bag = manifest[field];
    if (!bag || typeof bag !== "object") continue;
    for (const [name, range] of Object.entries(bag as Record<string, unknown>)) {
      if (typeof range === "string") declared[name] = range;
    }
  }
  return declared;
}

function collectInstalledVersions(
  packages: Record<string, { version?: string }>,
): Map<string, Set<string>> {
  const installedVersions = new Map<string, Set<string>>();
  for (const [key, data] of Object.entries(packages)) {
    if (!key.startsWith("node_modules/")) continue;
    const lastIndex = key.lastIndexOf("node_modules/");
    const tail = key.slice(lastIndex + "node_modules/".length);
    const parts = tail.split("/");
    const name = parts.length >= 2 && parts[0]!.startsWith("@")
      ? `${parts[0]}/${parts[1]}`
      : parts[0]!;
    if (!name || typeof data?.version !== "string") continue;
    const versions = installedVersions.get(name) ?? new Set<string>();
    versions.add(data.version);
    installedVersions.set(name, versions);
  }
  return installedVersions;
}

function appendDriftIssues(
  aggregate: LockfileAggregate,
  declared: Record<string, string>,
  installedVersions: Map<string, Set<string>>,
): void {
  for (const [name, range] of Object.entries(declared)) {
    const versions = installedVersions.get(name);
    if (!versions || versions.size === 0) {
      aggregate.issues.push({
        type: "missing",
        package: name,
        message: `${name} declared in package.json but not present in lockfile`,
      });
      continue;
    }
    for (const installed of versions) {
      if (!versionSatisfiesManifest(range, installed)) {
        aggregate.issues.push({
          type: "drift",
          package: name,
          message: `${name}: manifest range ${range} does not match installed ${installed}`,
        });
      }
    }
  }
}

function appendDuplicateIssues(
  aggregate: LockfileAggregate,
  installedVersions: Map<string, Set<string>>,
): void {
  for (const [name, versions] of installedVersions) {
    if (versions.size <= 1) continue;
    aggregate.issues.push({
      type: "duplicate",
      package: name,
      message: `${name} installed with ${versions.size} different versions: ${[...versions].join(", ")}`,
    });
  }
}

export async function checkDependencyLockfile(
  workspace: string,
  packageManager: PackageManager,
): Promise<LockfileAggregate> {
  const aggregate: LockfileAggregate = { present: false, issues: [] };
  const lockName = await resolveLockfileName(workspace, packageManager);
  if (!lockName) {
    aggregate.issues.push({ type: "missing", message: "No supported lockfile found" });
    return aggregate;
  }
  const lockPath = join(workspace, lockName);
  if (!(await fileExists(lockPath))) {
    aggregate.issues.push({ type: "missing", message: `Lockfile ${lockName} is missing` });
    return aggregate;
  }
  aggregate.present = true;
  if (packageManager !== "npm") return aggregate;

  let manifest: Record<string, unknown>;
  try {
    const manifestPath = join(workspace, "package.json");
    manifest = JSON.parse(await readBoundedFile(manifestPath, MAX_PACKAGE_MANIFEST_BYTES));
  } catch {
    aggregate.issues.push({ type: "missing", message: "package.json could not be read" });
    return aggregate;
  }
  let lock: { packages?: Record<string, { version?: string }> };
  try {
    lock = JSON.parse(await readBoundedFile(lockPath, MAX_LOCKFILE_BYTES));
  } catch {
    aggregate.issues.push({ type: "missing", message: `Lockfile ${lockName} could not be parsed` });
    return aggregate;
  }

  const declared = collectDeclaredDependencies(manifest);
  const installedVersions = collectInstalledVersions(lock.packages ?? {});
  appendDriftIssues(aggregate, declared, installedVersions);
  appendDuplicateIssues(aggregate, installedVersions);
  return aggregate;
}

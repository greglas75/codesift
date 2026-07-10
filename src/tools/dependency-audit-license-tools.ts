import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LicenseAggregate, LicenseInfo } from "./dependency-audit-types.js";

const PROBLEMATIC_LICENSE_PATTERNS = [
  /^GPL(-|$)/i,
  /^AGPL(-|$)/i,
  /^LGPL(-|$)/i,
  /^SSPL(-|$)/i,
  /^EUPL(-|$)/i,
  /^OSL(-|$)/i,
  /^CC-BY-NC/i,
  /copyleft/i,
];

const MAX_LICENSE_MANIFEST_BYTES = 1024 * 1024;
const MAX_LICENSE_MANIFESTS = 10_000;
const LICENSE_READ_CONCURRENCY = 16;

function isProblematicLicense(license: string): boolean {
  return PROBLEMATIC_LICENSE_PATTERNS.some((pattern) => pattern.test(license));
}

function normalizeLicenseField(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const objectValue = raw as { type?: unknown };
    if (typeof objectValue.type === "string") return objectValue.type;
  }
  return "UNKNOWN";
}

function isPackageManifest(path: string): boolean {
  if (!path.includes("node_modules/") || !path.endsWith("/package.json")) return false;
  const nodeModulesIndex = path.lastIndexOf("node_modules/");
  const tail = path.slice(nodeModulesIndex + "node_modules/".length);
  const parts = tail.split("/");
  return parts.length === 2 || (parts.length === 3 && parts[0]!.startsWith("@"));
}

async function readLicenseInfo(
  workspace: string,
  file: { path: string },
): Promise<{ packageName: string; license: string }> {
  const manifestPath = join(workspace, file.path);
  const metadata = await stat(manifestPath);
  if (metadata.size > MAX_LICENSE_MANIFEST_BYTES) {
    throw new Error("dependency manifest exceeds size limit");
  }
  const source = await readFile(manifestPath, "utf-8");
  const json = JSON.parse(source) as { name?: unknown; license?: unknown; licenses?: unknown };
  const packageName = typeof json.name === "string" ? json.name : file.path;
  if (json.license !== undefined) {
    return { packageName, license: normalizeLicenseField(json.license) };
  }
  const legacyLicense = Array.isArray(json.licenses) ? json.licenses[0] : undefined;
  return { packageName, license: normalizeLicenseField(legacyLicense) };
}

function appendLicense(
  aggregate: LicenseAggregate,
  packageName: string,
  license: string,
): void {
  aggregate.total++;
  aggregate.distribution[license] = (aggregate.distribution[license] ?? 0) + 1;
  if (isProblematicLicense(license)) {
    const finding: LicenseInfo = { package: packageName, license, is_problematic: true };
    aggregate.problematic.push(finding);
  }
}

export async function checkDependencyLicenses(
  workspace: string,
  indexFiles: Array<{ path: string }>,
): Promise<LicenseAggregate> {
  const aggregate: LicenseAggregate = { total: 0, problematic: [], distribution: {} };
  const packageManifests = indexFiles.filter((file) => isPackageManifest(file.path));
  if (packageManifests.length > MAX_LICENSE_MANIFESTS) {
    throw new Error("dependency manifest count exceeds limit");
  }
  for (let offset = 0; offset < packageManifests.length; offset += LICENSE_READ_CONCURRENCY) {
    const batch = packageManifests.slice(offset, offset + LICENSE_READ_CONCURRENCY);
    const licenses = await Promise.all(batch.map((file) => readLicenseInfo(workspace, file)));
    for (const { packageName, license } of licenses) {
      appendLicense(aggregate, packageName, license);
    }
  }
  return aggregate;
}

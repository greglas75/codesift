// Bucketed environment profile — coarse enough that it can never identify a
// machine, precise enough to slice behaviour by config (spec §1). No hostnames,
// no paths, no exact counts that could fingerprint.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as os from "node:os";

export interface EnvProfile {
  platform: string; // "darwin" | "linux" | "win32"
  arch: string; // "arm64" | "x64" ...
  ram_bucket: string;
  cores: number;
  node_ver: string; // major only, e.g. "20"
  codesift_ver: string;
  repo_size_bucket?: string; // present when a repo is in scope
  top3_ext?: string[]; // top-3 file extensions in the indexed repo (no names)
}

function ramBucket(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb < 8) return "<8gb";
  if (gb < 16) return "8-16gb";
  if (gb < 32) return "16-32gb";
  if (gb < 64) return "32-64gb";
  return ">=64gb";
}

export function repoSizeBucket(fileCount: number): string {
  if (fileCount < 1000) return "<1k";
  if (fileCount < 10_000) return "1-10k";
  if (fileCount < 50_000) return "10-50k";
  return ">50k";
}

let versionCache: string | null = null;

export function getCodesiftVersion(): string {
  if (versionCache) return versionCache;
  // package.json sits at the repo root; this module is src|dist/storage/telemetry/.
  for (const rel of ["../../../package.json", "../../../../package.json"]) {
    try {
      const p = fileURLToPath(new URL(rel, import.meta.url));
      const pkg = JSON.parse(readFileSync(p, "utf-8")) as { name?: string; version?: string };
      if (pkg.name === "codesift-mcp" && typeof pkg.version === "string") {
        versionCache = pkg.version;
        return versionCache;
      }
    } catch {
      /* try next */
    }
  }
  versionCache = "unknown";
  return versionCache;
}

/** Build the environment profile. Repo dimensions are optional — omitted when
 *  no repo is in scope (e.g. `telemetry show` outside a project). */
export function buildEnvProfile(repo?: { fileCount: number; topExts: string[] }): EnvProfile {
  const nodeMajor = process.versions.node.split(".")[0] ?? process.versions.node;
  const profile: EnvProfile = {
    platform: os.platform(),
    arch: os.arch(),
    ram_bucket: ramBucket(os.totalmem()),
    cores: os.cpus().length,
    node_ver: nodeMajor,
    codesift_ver: getCodesiftVersion(),
  };
  if (repo) {
    profile.repo_size_bucket = repoSizeBucket(repo.fileCount);
    profile.top3_ext = repo.topExts.slice(0, 3);
  }
  return profile;
}

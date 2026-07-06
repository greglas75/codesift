/**
 * PHP/Yii2-specific code intelligence tools.
 *
 * Implementation module extracted from the legacy php-tools facade.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getCodeIndex } from "./index-tools.js";

// 7a. resolve_php_namespace — PSR-4 resolver
// ---------------------------------------------------------------------------

export interface PhpNamespaceResolution {
  class_name: string;
  namespace: string;
  file_path: string | null;
  exists: boolean;
  psr4_root: string | null;
  psr4_prefix: string | null;
}

export async function resolvePhpNamespace(
  repo: string,
  className: string,
): Promise<PhpNamespaceResolution> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const composer = await readJsonSafe(join(index.root, "composer.json"));
  const psr4: Record<string, string | string[]> = {
    ...(composer?.autoload?.["psr-4"] ?? {}),
    ...(composer?.["autoload-dev"]?.["psr-4"] ?? {}),
  };

  // Strip leading backslash
  const normalized = className.replace(/^\\/, "");
  const parts = normalized.split("\\");
  const namespaceOnly = parts.slice(0, -1).join("\\");
  const shortName = parts[parts.length - 1]!;

  // Find matching PSR-4 prefix (longest match wins)
  let bestPrefix: string | null = null;
  let bestRoot: string | null = null;
  for (const [prefix, roots] of Object.entries(psr4)) {
    const normalizedPrefix = prefix.replace(/\\$/, "");
    if (normalized.startsWith(normalizedPrefix + "\\") || normalized === normalizedPrefix) {
      if (!bestPrefix || normalizedPrefix.length > bestPrefix.length) {
        bestPrefix = normalizedPrefix;
        bestRoot = Array.isArray(roots) ? roots[0] ?? null : roots;
      }
    }
  }

  if (!bestPrefix || !bestRoot) {
    return {
      class_name: shortName,
      namespace: namespaceOnly,
      file_path: null,
      exists: false,
      psr4_root: null,
      psr4_prefix: null,
    };
  }

  // Construct file path: strip prefix, replace \ with /, append .php
  const remainder = normalized.slice(bestPrefix.length).replace(/^\\/, "");
  const relativePath = remainder.replace(/\\/g, "/") + ".php";
  const root = bestRoot.replace(/\/$/, "");
  const filePath = root + "/" + relativePath;

  // Check if file exists in index (strip leading ./ for comparison)
  const normalizedFP = filePath.replace(/^\.\//, "");
  const exists = index.files.some((f) => f.path === normalizedFP || f.path === filePath);

  return {
    class_name: shortName,
    namespace: namespaceOnly,
    file_path: filePath,
    exists,
    psr4_root: bestRoot,
    psr4_prefix: bestPrefix,
  };
}

// ---------------------------------------------------------------------------

async function readJsonSafe(path: string): Promise<any> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

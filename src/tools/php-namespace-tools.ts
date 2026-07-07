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
  const psr4 = mergePsr4Maps(
    composer?.autoload?.["psr-4"],
    composer?.["autoload-dev"]?.["psr-4"],
  );

  // Strip leading backslash
  const normalized = className.replace(/^\\/, "");
  const parts = normalized.split("\\");
  const namespaceOnly = parts.slice(0, -1).join("\\");
  const shortName = parts[parts.length - 1]!;

  // Find matching PSR-4 prefix (longest match wins). Composer also allows an
  // empty fallback prefix and multiple roots per prefix.
  let bestMatch: { prefix: string; roots: string[] } | null = null;
  for (const [prefix, roots] of Object.entries(psr4)) {
    const normalizedPrefix = prefix.replace(/\\$/, "");
    const matches =
      normalizedPrefix === "" ||
      normalized.startsWith(normalizedPrefix + "\\") ||
      normalized === normalizedPrefix;
    if (matches) {
      if (!bestMatch || normalizedPrefix.length > bestMatch.prefix.length) {
        bestMatch = {
          prefix: normalizedPrefix,
          roots: (Array.isArray(roots) ? roots : [roots]).filter(Boolean),
        };
      }
    }
  }

  if (!bestMatch || bestMatch.roots.length === 0) {
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
  const remainder = bestMatch.prefix === ""
    ? normalized
    : normalized.slice(bestMatch.prefix.length).replace(/^\\/, "");
  const relativePath = remainder.replace(/\\/g, "/") + ".php";
  const candidates = bestMatch.roots.map((psr4Root) => {
    const root = psr4Root.replace(/\/$/, "");
    const filePath = root ? `${root}/${relativePath}` : relativePath;
    return { psr4Root, filePath };
  });

  const existing = candidates.find(({ filePath }) => {
    const normalizedFP = filePath.replace(/^\.\//, "");
    return index.files.some((f) => f.path === normalizedFP || f.path === filePath);
  });
  const selected = existing ?? candidates[0]!;

  return {
    class_name: shortName,
    namespace: namespaceOnly,
    file_path: selected.filePath,
    exists: Boolean(existing),
    psr4_root: selected.psr4Root,
    psr4_prefix: bestMatch.prefix,
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

function mergePsr4Maps(
  ...maps: Array<Record<string, string | string[]> | undefined>
): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [prefix, roots] of Object.entries(map)) {
      const existing = merged[prefix] ?? [];
      for (const root of Array.isArray(roots) ? roots : [roots]) {
        if (!root || existing.includes(root)) continue;
        existing.push(root);
      }
      merged[prefix] = existing;
    }
  }
  return merged;
}

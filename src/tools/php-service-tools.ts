/**
 * PHP/Yii2-specific code intelligence tools.
 *
 * Implementation module extracted from the legacy php-tools facade.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getCodeIndex } from "./index-tools.js";
import { resolvePhpNamespace } from "./php-namespace-tools.js";

// 7e. resolve_php_service — DI / Service Locator resolver
// ---------------------------------------------------------------------------

export interface PhpServiceResolution {
  name: string;
  class: string | null;
  file: string | null;
  config_file: string | null;
  /** Sprint 3: tracks where the service was defined.
   *   "components"           — top-level Yii2 application components
   *   "container.singletons" — DI container singletons
   *   "container.definitions"— DI container regular bindings
   *   "module:<id>"          — module-scoped components (modules.<id>.components.X)
   *   "factory"              — closure / factory function (no static class resolution)
   */
  source: string;
  /** Sprint 3: true when the service was defined as a closure/factory and we
   *  cannot statically determine the produced class. Caller can choose to
   *  skip these or surface them as TODOs. */
  is_factory?: boolean;
}

export async function resolvePhpService(
  repo: string,
  options?: { service_name?: string },
): Promise<{ services: PhpServiceResolution[]; total: number }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const services: PhpServiceResolution[] = [];
  // Sprint 3: include `params*.php` only as suppress-source — those files
  // hold flat key-value pairs that look like components but aren't. We also
  // drop config/test*.php (intentionally divergent) and pick up the broader
  // *-local.php and main-*.php variants (advanced template + per-env splits).
  const configFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".php")) return false;
    if (/config\/test/.test(f.path)) return false;
    return /config\/(?:web|console|main|db|api|backend|frontend|common)(?:[-_][\w-]+)?\.php$/.test(
      f.path,
    );
  });

  // Track (name, class, source, configFile) tuples so we don't duplicate
  // when the same component appears in both web.php and main-local.php.
  const seen = new Set<string>();
  const dedupKey = (
    name: string,
    cls: string | null,
    sourceLabel: string,
    file: string,
  ): string => `${sourceLabel}::${name}::${cls ?? "<factory>"}::${file}`;

  const pushService = (s: PhpServiceResolution): void => {
    const key = dedupKey(s.name, s.class, s.source, s.config_file ?? "");
    if (seen.has(key)) return;
    seen.add(key);
    services.push(s);
  };

  for (const cf of configFiles) {
    let source: string;
    try {
      source = await readFile(join(index.root, cf.path), "utf-8");
    } catch { continue; }

    // Match component definitions: 'componentName' => ['class' => 'FQCN', ...]
    // Top-level components live under 'components' => [...]; module-scoped
    // ones live under 'modules' => ['<id>' => ['components' => [...]]]. We
    // don't try to distinguish here — every match is tagged via post-pass.
    //
    // The key pattern accepts both bare names ("db") and FQCNs
    // ("app\\interfaces\\LoggerInterface") because container.singletons /
    // container.definitions almost always use FQCNs as keys.
    const componentRe = /['"]([\w\\-]+)['"]\s*=>\s*\[/g;
    let match: RegExpExecArray | null;
    while ((match = componentRe.exec(source)) !== null) {
      const name = match[1]!;
      const openBracket = match.index + match[0].lastIndexOf("[");
      const closeBracket = findMatchingPhpArrayBracket(source, openBracket);
      if (closeBracket === -1) continue;
      const cls = extractTopLevelClassValue(source.slice(openBracket + 1, closeBracket));
      if (!cls) continue;

      if (options?.service_name && name !== options.service_name) continue;

      // Resolve class to file via PSR-4
      let filePath: string | null = null;
      try {
        const resolved = await resolvePhpNamespace(repo, cls);
        if (resolved.exists) filePath = resolved.file_path;
      } catch { /* ignore */ }

      // Best-effort source labeling: scan the prefix up to the match to see
      // whether we're inside `'modules' => ['x' => ['components' => [...]]]`
      // or `'container' => ['singletons' => [...]]`. This is fuzzy; the
      // labeling failures fall back to "components".
      const prefix = source.slice(0, match.index);
      const sourceLabel = inferConfigSection(prefix);

      pushService({
        name,
        class: cls,
        file: filePath,
        config_file: cf.path,
        source: sourceLabel,
      });
    }

    // DI container: `Yii::$container->set(InterfaceName::class, ImplName::class)`
    // and the static `'container' => ['definitions' => [...]]` form. Both are
    // common in Yii2 codebases that use interface-based DI.
    const containerSetRe =
      /Yii::\$container->set\s*\(\s*([\w\\]+)::class\s*,\s*([\w\\]+)::class/g;
    while ((match = containerSetRe.exec(source)) !== null) {
      const iface = match[1]!;
      const impl = match[2]!;
      if (options?.service_name && iface !== options.service_name) continue;

      let filePath: string | null = null;
      try {
        const resolved = await resolvePhpNamespace(repo, impl);
        if (resolved.exists) filePath = resolved.file_path;
      } catch { /* ignore */ }

      pushService({
        name: iface,
        class: impl,
        file: filePath,
        config_file: cf.path,
        source: "container.set",
      });
    }

    // Closure / factory: `'mailer' => function() { return new Mailer(); }`
    // We can't statically resolve the produced class, so we surface the
    // service name with class=null and is_factory=true so callers can
    // either ignore them or flag them as needs-manual-review.
    const factoryRe =
      /['"]([\w-]+)['"]\s*=>\s*function\s*\(/g;
    while ((match = factoryRe.exec(source)) !== null) {
      const name = match[1]!;
      if (options?.service_name && name !== options.service_name) continue;
      pushService({
        name,
        class: null,
        file: null,
        config_file: cf.path,
        source: "factory",
        is_factory: true,
      });
    }
  }

  return { services, total: services.length };
}

function findMatchingPhpArrayBracket(source: string, openBracket: number): number {
  let depth = 0;
  let i = openBracket;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === "#") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipPhpString(source, i);
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function extractTopLevelClassValue(block: string): string | null {
  let depth = 0;
  let i = 0;
  while (i < block.length) {
    if (depth === 0) {
      const match = /^\s*['"]class['"]\s*=>\s*(?:['"](\\?[\w\\]+)['"]|(\\?[\w\\]+)\s*::\s*class)/.exec(block.slice(i));
      if (match) return match[1] ?? match[2]!;
    }

    const c = block[i]!;
    if (c === "/" && block[i + 1] === "/") {
      const nl = block.indexOf("\n", i);
      i = nl === -1 ? block.length : nl + 1;
      continue;
    }
    if (c === "/" && block[i + 1] === "*") {
      const end = block.indexOf("*/", i + 2);
      i = end === -1 ? block.length : end + 2;
      continue;
    }
    if (c === "#") {
      const nl = block.indexOf("\n", i);
      i = nl === -1 ? block.length : nl + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipPhpString(block, i);
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") depth--;
    i++;
  }
  return null;
}

function skipPhpString(source: string, quoteIndex: number): number {
  const quote = source[quoteIndex]!;
  let i = quoteIndex + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i++;
  }
  return source.length;
}

/**
 * Sprint 3 helper: given the source prefix up to a component match, identify
 * which Yii2 config section we're inside by walking the prefix forward with a
 * bracket-balanced stack. Each `'KEY' => [` pushes KEY onto the stack; each
 * matching `]` pops it. At the end of the prefix the stack tells us the
 * exact nesting path, regardless of how many sibling sections came before.
 *
 * Why not regex: regex can't track balanced brackets. The previous version
 * used non-greedy `[\\s\\S]*?` which incorrectly matched a `'modules' =>
 * ['x' => [...]]` block that had already closed by the time we reached a
 * `'container' => ['singletons' => ...]` later in the file.
 *
 * Returns one of:
 *   "module:<id>"            — inside `'modules' => ['<id>' => ['components' => [<HERE>...
 *   "container.singletons"   — inside `'container' => ['singletons' => [<HERE>...
 *   "container.definitions"  — inside `'container' => ['definitions' => [<HERE>...
 *   "components"             — fallback (top-level components or unknown)
 *
 * String literals (single + double quoted) and PHP comments are skipped so
 * brackets inside them don't confuse the depth counter.
 */
function inferConfigSection(prefix: string): string {
  type Frame = { key: string; depth: number };
  const stack: Frame[] = [];
  let depth = 0;

  let i = 0;
  while (i < prefix.length) {
    const c = prefix[i]!;

    // Skip comments
    if (c === "/" && prefix[i + 1] === "/") {
      const nl = prefix.indexOf("\n", i);
      i = nl === -1 ? prefix.length : nl + 1;
      continue;
    }
    if (c === "/" && prefix[i + 1] === "*") {
      const end = prefix.indexOf("*/", i + 2);
      i = end === -1 ? prefix.length : end + 2;
      continue;
    }
    if (c === "#") {
      const nl = prefix.indexOf("\n", i);
      i = nl === -1 ? prefix.length : nl + 1;
      continue;
    }

    // Look for `'KEY' => [` BEFORE the generic string-skip — otherwise the
    // string-skip swallows the opening quote and we never push the key.
    if (c === '"' || c === "'") {
      const m = /^(['"])([\w\\-]+)\1\s*=>\s*\[/.exec(prefix.slice(i));
      if (m) {
        const keyName = m[2]!;
        // Push at the new depth (after the bracket we're about to enter).
        stack.push({ key: keyName, depth: depth + 1 });
        depth++;
        i += m[0].length;
        continue;
      }
      // Plain string literal — skip past the closing quote.
      const quote = c;
      i++;
      while (i < prefix.length) {
        if (prefix[i] === "\\") { i += 2; continue; }
        if (prefix[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }

    if (c === "[") {
      depth++;
      i++;
      continue;
    }
    if (c === "]") {
      depth--;
      while (stack.length > 0 && stack[stack.length - 1]!.depth > depth) {
        stack.pop();
      }
      i++;
      continue;
    }

    i++;
  }

  // Read the live nesting path from the stack.
  const keys = stack.map((f) => f.key);

  // module:<id> when we're inside modules.<id>.components.<*>
  const modIdx = keys.indexOf("modules");
  if (modIdx !== -1 && keys.length >= modIdx + 3) {
    const moduleId = keys[modIdx + 1]!;
    const inner = keys[modIdx + 2]!;
    if (inner === "components") return `module:${moduleId}`;
  }

  const cIdx = keys.indexOf("container");
  if (cIdx !== -1 && keys.length >= cIdx + 2) {
    const sub = keys[cIdx + 1]!;
    if (sub === "singletons") return "container.singletons";
    if (sub === "definitions") return "container.definitions";
  }

  return "components";
}

// ---------------------------------------------------------------------------

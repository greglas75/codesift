/**
 * PHP/Yii2-specific code intelligence tools.
 *
 * Implementation module extracted from the legacy php-tools facade.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getIndexSummary, streamRepoSymbols } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";
import { extractPhpNamespace, extractPhpUseImports, resolvePhpClassReference } from "./php-import-utils.js";

// 7c. trace_php_event — Event → Listener chain
// ---------------------------------------------------------------------------

export interface PhpEventChain {
  event_name: string;
  triggers: { file: string; line: number; context: string }[];
  listeners: { file: string; line: number; context: string }[];
}

/**
 * Build a class-const → literal-value map for the entire index. Yii2's
 * canonical event idiom is `Event::on(User::class, User::EVENT_AFTER_LOGIN, ...)`,
 * where `EVENT_AFTER_LOGIN` is a class constant with a string value. The
 * default tracePhpEvent regex only sees literals, so without resolution
 * `Class::CONST` references look like dead code. This pre-pass walks all
 * `constant` symbols belonging to PHP classes and extracts their string /
 * int literal values from `source`.
 *
 * Map keys are `ClassName::CONST_NAME`. Class lookup is by last name segment
 * — same convention as isActiveRecordHierarchy — so namespace prefixes don't
 * matter for callers using `User::EVENT_X` against a class named `User`.
 *
 * Returns an empty map if no constants resolve. Cost is one O(n) walk per
 * call; could be cached on the index in the future if event tracing becomes
 * a hot path.
 */
interface ConstantValueIndex {
  values: Map<string, string>;
  globalValues: Map<string, string>;
  ambiguousShortKeys: Set<string>;
}

/**
 * Fed one symbol at a time, so the map is built while symbols stream past instead of over a
 * materialised array. Owners are collected as they arrive; constants are held (only those, and
 * only until `finish`) because a constant can precede its class in index order, and the old
 * two-loop walk saw every owner before the first constant.
 */
function createConstantValueCollector(): {
  add: (s: CodeSymbol) => void;
  finish: () => ConstantValueIndex;
} {
  const classIdToName = new Map<string, string>();
  const classIdToFqcn = new Map<string, string>();
  const constants: CodeSymbol[] = [];
  return {
    add(s) {
      if (s.kind === "class" || s.kind === "interface" || s.kind === "enum") {
        // Use the symbol id as key — every constant carries `parent` referring
        // to its enclosing class id, so we only need the id→name lookup.
        const id = (s as { id?: string }).id;
        if (id) {
          classIdToName.set(id, s.name);
          classIdToFqcn.set(id, phpClassFqcn(s));
        }
      } else if (s.kind === "constant" && s.parent && s.source) {
        constants.push(s);
      }
    },
    finish: () => buildConstantValueMap(constants, classIdToName, classIdToFqcn),
  };
}

function buildConstantValueMap(
  constants: CodeSymbol[],
  classIdToName: Map<string, string>,
  classIdToFqcn: Map<string, string>,
): ConstantValueIndex {
  const out = new Map<string, string>();
  const globalValues = new Map<string, string>();
  const ambiguousShortKeys = new Set<string>();
  for (const s of constants) {
    if (s.kind !== "constant") continue;
    if (!s.parent || !s.source) continue;
    const className = classIdToName.get(s.parent);
    if (!className) continue;
    // Match the literal value: `const NAME = 'value';` or `const NAME = "v";`
    // or `const NAME = 42;`. We accept the first occurrence in the constant's
    // source slice — the extractor already narrows source to a single decl.
    const m = /=\s*(?:['"]([^'"]+)['"]|(-?\d+(?:\.\d+)?))/.exec(s.source);
    if (!m) continue;
    const value = m[1] ?? m[2];
    if (value === undefined) continue;
    const shortKey = `${className}::${s.name}`;
    if (out.has(shortKey)) {
      ambiguousShortKeys.add(shortKey);
    } else {
      out.set(shortKey, value);
    }
    const fqcn = classIdToFqcn.get(s.parent);
    if (fqcn === className) {
      globalValues.set(shortKey, value);
    }
    if (fqcn && fqcn !== className) {
      out.set(`${fqcn}::${s.name}`, value);
    }
  }
  return { values: out, globalValues, ambiguousShortKeys };
}

function phpClassFqcn(cls: { name: string; source?: string }): string {
  const name = cls.name.replace(/^\\/, "");
  if (name.includes("\\")) return name;
  const namespace = extractPhpNamespace(cls.source);
  return namespace ? `${namespace}\\${name}` : name;
}

interface FilePhpContext {
  imports: Map<string, string>;
  namespace: string | null;
}

/**
 * Symbol sources are added first (as they stream past, via `addSource`) and file contents after
 * (`addFiles`) — the order the single function used: imports merge last-wins and the namespace
 * is first-wins, so the order is part of the result.
 */
function createFilePhpContexts(): {
  addSource: (file: string, source: string) => void;
  addFiles: (index: { root: string; files: Array<{ path: string }> }) => Promise<{ contexts: Map<string, FilePhpContext>; warnings: string[] }>;
} {
  const byFile = new Map<string, FilePhpContext>();
  const warnings: string[] = [];
  const addSource = (file: string, source: string): void => {
    const context = byFile.get(file) ?? { imports: new Map<string, string>(), namespace: null };
    for (const [alias, fqcn] of extractPhpUseImports(source)) {
      context.imports.set(alias, fqcn);
    }
    context.namespace ??= extractPhpNamespace(source);
    byFile.set(file, context);
  };
  return { addSource, addFiles: (index) => addFileContexts(index, addSource, byFile, warnings) };
}

async function addFileContexts(
  index: { root: string; files: Array<{ path: string }> },
  addSource: (file: string, source: string) => void,
  byFile: Map<string, FilePhpContext>,
  warnings: string[],
): Promise<{ contexts: Map<string, FilePhpContext>; warnings: string[] }> {
  for (const file of index.files) {
    if (!file.path.endsWith(".php")) continue;
    try {
      addSource(file.path, await readFile(join(index.root, file.path), "utf-8"));
    } catch {
      // File content is an enhancement for import/namespace context; indexed
      // symbol source is still enough for literal and FQCN event tracing.
      warnings.push(`Unable to read PHP file for import context: ${file.path}`);
    }
  }

  return { contexts: byFile, warnings };
}

export async function tracePhpEvent(
  repo: string,
  options?: { event_name?: string },
): Promise<{ events: PhpEventChain[]; total: number; warnings?: string[] }> {
  const index = await getIndexSummary(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const eventMap = new Map<string, PhpEventChain>();
  // Pass 1, streamed: every symbol feeds the constant map and the per-file import context. Both
  // must be complete before any trigger is resolved, so the scan below is a second pass rather
  // than the same one.
  const constantCollector = createConstantValueCollector();
  const fileContextBuilder = createFilePhpContexts();
  await streamRepoSymbols(repo, { withSource: true }, (batch) => {
    for (const sym of batch) {
      constantCollector.add(sym);
      if (sym.source) fileContextBuilder.addSource(sym.file, sym.source);
    }
  }, { skipFreshness: true });
  const constantValues = constantCollector.finish();
  const { contexts: fileContexts, warnings } = await fileContextBuilder.addFiles(index);

  const getOrCreate = (name: string): PhpEventChain => {
    let e = eventMap.get(name);
    if (!e) {
      e = { event_name: name, triggers: [], listeners: [] };
      eventMap.set(name, e);
    }
    return e;
  };

  // Resolve `Class::CONST` references to their literal values via the pre-pass
  // map. Returns the original key when the class+const pair isn't indexed
  // (e.g. constants defined in vendor/) so the trace at least shows there's
  // SOMETHING happening at this site.
  const resolveEventName = (raw: string, file: string): string => {
    const [rawClassRef, constName] = raw.split("::");
    if (!rawClassRef || !constName) return raw.replace(/^\\/, "");
    const classRef = rawClassRef.replace(/^\\/, "");
    const normalized = `${classRef}::${constName}`;
    if (!classRef || !constName) return normalized;
    const fileContext = fileContexts.get(file);
    const resolvedClass = resolvePhpClassReference(
      rawClassRef,
      fileContext ? { namespace: fileContext.namespace, imports: fileContext.imports } : undefined,
    );
    const resolvedKey = `${resolvedClass}::${constName}`;
    if (constantValues.values.has(resolvedKey)) {
      return constantValues.values.get(resolvedKey)!;
    }

    if (!rawClassRef.includes("\\") && !fileContext?.namespace && !fileContext?.imports.get(classRef)) {
      const globalValue = constantValues.globalValues.get(normalized);
      if (globalValue) return globalValue;
    }
    if (rawClassRef.startsWith("\\") && constantValues.values.has(normalized)) {
      return constantValues.values.get(normalized)!;
    }

    const shortClass = normalized.replace(/^.*\\([^\\]+::)/, "$1");
    if (!constantValues.ambiguousShortKeys.has(shortClass) && constantValues.values.has(shortClass)) {
      return constantValues.values.get(shortClass)!;
    }
    return normalized;
  };

  const constRefPattern = String.raw`\\?[A-Za-z_][\w]*(?:\\[A-Za-z_][\w]*)*::[A-Za-z_][\w]*`;
  const classRefPattern = String.raw`\\?[A-Za-z_][\w]*(?:\\[A-Za-z_][\w]*)*::class`;

  // Scan PHP file symbols for event triggers and listeners — pass 2, streamed again.
  await streamRepoSymbols(repo, { withSource: true }, (batch) => {
  for (const sym of batch) {
    if (!sym.file.endsWith(".php") || !sym.source) continue;
    const source = sym.source;

    // Triggers: ->trigger('eventName') or ->trigger(Class::CONST)
    // Now also accepts a bare identifier path (Foo::BAR) in addition to the
    // string-literal form.
    const triggerRe = new RegExp(
      String.raw`->trigger\s*\(\s*(?:['"]([^'"]+)['"]|(${constRefPattern}))`,
      "g",
    );
    let match: RegExpExecArray | null;
    while ((match = triggerRe.exec(source)) !== null) {
      const literal = match[1];
      const constRef = match[2];
      const eventName = literal ?? (constRef ? resolveEventName(constRef, sym.file) : undefined);
      if (!eventName) continue;
      if (options?.event_name && eventName !== options.event_name) continue;
      const line = sym.start_line + (source.slice(0, match.index).match(/\n/g)?.length ?? 0);
      getOrCreate(eventName).triggers.push({
        file: sym.file,
        line,
        context: extractLineContext(source, match.index),
      });
    }

    // Listeners: ->on('eventName', ...) or ::on('eventName', ...) or
    //            ::on(Foo::class, Foo::EVENT_BAR, ...)
    // Yii2 prefers the class-const form for built-in events, so resolution is
    // critical here.
    const listenerRe = new RegExp(
      String.raw`(?:->|::)on\s*\(\s*(?:${classRefPattern}\s*,\s*)?(?:['"]([^'"]+)['"]|(${constRefPattern}))`,
      "g",
    );
    while ((match = listenerRe.exec(source)) !== null) {
      const literal = match[1];
      const constRef = match[2];
      const eventName = literal ?? (constRef ? resolveEventName(constRef, sym.file) : undefined);
      if (!eventName) continue;
      if (options?.event_name && eventName !== options.event_name) continue;
      const line = sym.start_line + (source.slice(0, match.index).match(/\n/g)?.length ?? 0);
      getOrCreate(eventName).listeners.push({
        file: sym.file,
        line,
        context: extractLineContext(source, match.index),
      });
    }
  }
  }, { skipFreshness: true });

  const events = [...eventMap.values()];
  return warnings.length > 0
    ? { events, total: events.length, warnings }
    : { events, total: events.length };
}

// ---------------------------------------------------------------------------

function extractLineContext(source: string, index: number): string {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const lineEnd = source.indexOf("\n", index);
  const end = lineEnd === -1 ? source.length : lineEnd;
  return source.slice(lineStart, end).trim().slice(0, 200);
}

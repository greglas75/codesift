/**
 * PHP/Yii2-specific code intelligence tools.
 *
 * Implementation module extracted from the legacy php-tools facade.
 */
import { getCodeIndex } from "./index-tools.js";

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
function buildConstantValueMap(
  index: { symbols: Array<{ name: string; kind: string; parent?: string; source?: string }> },
): Map<string, string> {
  const out = new Map<string, string>();
  // First, build classId → className map so we can resolve const owners.
  const classIdToName = new Map<string, string>();
  for (const s of index.symbols) {
    if (s.kind === "class" || s.kind === "interface" || s.kind === "enum") {
      // Use the symbol id as key — every constant carries `parent` referring
      // to its enclosing class id, so we only need the id→name lookup.
      const id = (s as { id?: string }).id;
      if (id) classIdToName.set(id, s.name);
    }
  }
  for (const s of index.symbols) {
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
    out.set(`${className}::${s.name}`, value);
  }
  return out;
}

export async function tracePhpEvent(
  repo: string,
  options?: { event_name?: string },
): Promise<{ events: PhpEventChain[]; total: number }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const eventMap = new Map<string, PhpEventChain>();
  const constantValues = buildConstantValueMap(index);

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
  const resolveEventName = (raw: string): string => {
    return constantValues.get(raw) ?? raw;
  };

  // Scan PHP file symbols for event triggers and listeners
  const phpSymbols = index.symbols.filter((s) => s.file.endsWith(".php") && s.source);

  for (const sym of phpSymbols) {
    const source = sym.source!;

    // Triggers: ->trigger('eventName') or ->trigger(Class::CONST)
    // Now also accepts a bare identifier path (Foo::BAR) in addition to the
    // string-literal form.
    const triggerRe =
      /->trigger\s*\(\s*(?:['"]([^'"]+)['"]|([A-Z_][\w]*::[A-Z_][\w]*))/g;
    let match: RegExpExecArray | null;
    while ((match = triggerRe.exec(source)) !== null) {
      const literal = match[1];
      const constRef = match[2];
      const eventName = literal ?? (constRef ? resolveEventName(constRef) : undefined);
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
    const listenerRe =
      /(?:->|::)on\s*\(\s*(?:[A-Z_][\w]*::class\s*,\s*)?(?:['"]([^'"]+)['"]|([A-Z_][\w]*::[A-Z_][\w]*))/g;
    while ((match = listenerRe.exec(source)) !== null) {
      const literal = match[1];
      const constRef = match[2];
      const eventName = literal ?? (constRef ? resolveEventName(constRef) : undefined);
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

  const events = [...eventMap.values()];
  return { events, total: events.length };
}

// ---------------------------------------------------------------------------

function extractLineContext(source: string, index: number): string {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const lineEnd = source.indexOf("\n", index);
  const end = lineEnd === -1 ? source.length : lineEnd;
  return source.slice(lineStart, end).trim().slice(0, 200);
}

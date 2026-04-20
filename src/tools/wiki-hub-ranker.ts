/**
 * Wiki hub ranker — ranks symbols by file-level PageRank with a builtin-name
 * blocklist gate to keep JS/TS prototype methods out of the hub list when
 * they accidentally collide with project symbols defined in low-importance
 * files. See spec D4 (Layer 2 + Layer 3).
 */

/** JavaScript / TypeScript prototype method names frequently appearing as
 *  fake callers when extractCallSites misclassifies `obj.method(...)` as a
 *  call to a bare project function. Used to filter hubs whose defining file
 *  is not structurally important (PageRank file_rank > 20). */
export const JS_BUILTIN_METHOD_NAMES: ReadonlySet<string> = new Set([
  // Array.prototype
  "map", "filter", "reduce", "reduceRight", "forEach", "find", "findIndex",
  "findLast", "findLastIndex", "some", "every", "includes", "indexOf",
  "lastIndexOf", "slice", "splice", "concat", "join", "push", "pop",
  "shift", "unshift", "sort", "reverse", "flat", "flatMap", "fill",
  "copyWithin", "entries", "keys", "values", "at",
  // String.prototype (subset)
  "trim", "trimStart", "trimEnd", "split", "replace", "replaceAll",
  "substring", "substr", "startsWith", "endsWith", "padStart", "padEnd",
  "repeat", "normalize", "toLowerCase", "toUpperCase", "charAt", "charCodeAt",
  "codePointAt",
  // Object.prototype / Object methods commonly reached via .x()
  "toString", "valueOf", "hasOwnProperty", "isPrototypeOf",
  // Number/Date common methods
  "now", "parse", "getTime", "getDate", "getMonth", "getFullYear",
  "toFixed", "toPrecision", "toISOString", "toJSON",
  // Promise / Map / Set
  "then", "catch", "finally", "get", "set", "has", "delete", "add", "clear",
  "size",
  // Misc common short names that frequently appear as .x() callsites
  "bind", "call", "apply", "flat",
]);

import type { BuiltinPatternDefinition } from "../types.js";

export const PYTHON_PATTERNS: Record<string, BuiltinPatternDefinition> = {
  // --- Python anti-patterns ---
  "mutable-default": {
    regex: /def\s+\w+\s*\([^)]*=\s*(?:\[\s*\]|\{\s*\}|set\s*\(\s*\))/,
    description: "Mutable default argument ([], {}, set()) — shared between calls (Python)",
  },
  "bare-except": {
    regex: /except\s*:/,
    description: "Bare except: catches everything including KeyboardInterrupt (Python)",
  },
  "broad-except": {
    regex: /except\s+(?:Exception|BaseException)\s*:/,
    description: "Broad exception catch — hides real errors (Python)",
  },
  "global-keyword": {
    regex: /\bglobal\s+\w+/,
    description: "global keyword — mutable global state makes code hard to test (Python)",
  },
  "star-import": {
    regex: /from\s+\S+\s+import\s+\*/,
    description: "Star import — pollutes namespace, breaks static analysis (Python)",
  },
  "print-debug-py": {
    regex: /^\s*print\s*\(/m,
    description: "print() in production code — use logging module (Python)",
  },
  "eval-exec": {
    regex: /\b(?:eval|exec)\s*\(/,
    description: "eval()/exec() — code injection risk (Python)",
  },
  "shell-true": {
    regex: /subprocess\.\w+\s*\([^)]*shell\s*=\s*True/,
    description: "subprocess with shell=True — command injection risk (Python)",
  },
  "pickle-load": {
    regex: /pickle\.(?:load|loads)\s*\(/,
    description: "pickle.load/loads — arbitrary code execution from untrusted data (Python)",
  },
  "yaml-unsafe": {
    regex: /yaml\.load\s*\([^)]*\)(?![\s\S]{0,30}Loader)/,
    description: "yaml.load without SafeLoader — arbitrary code execution risk (Python)",
  },
  "open-no-with": {
    regex: /(?<!with\s{1,20})\bopen\s*\([^)]+\)\s*(?:\.\w+|;|$)/m,
    description: "open() without with statement — resource leak if exception occurs (Python)",
  },
  "string-concat-loop": {
    regex: /for\s+\w+\s+in\s+[\s\S]{0,200}?\+=\s*(?:['"]|f['"]|str\()/,
    description: "String concatenation in loop — O(n^2), use join() or list append (Python)",
  },
  "datetime-naive": {
    regex: /datetime\.(?:now|utcnow)\s*\(\s*\)/,
    description: "datetime.now()/utcnow() without timezone — naive datetime causes bugs (Python)",
  },
  "shadow-builtin": {
    regex: /^(?:list|dict|set|id|type|input|map|filter|range|str|int|float|bool|tuple|bytes|object|print|open|format|len|sum|min|max|any|all|zip|enumerate|sorted|reversed|next|iter|super|hash|dir|vars|globals|locals)\s*=/m,
    description: "Assignment shadows Python builtin — breaks code that uses the builtin later (Python)",
  },
  "n-plus-one-django": {
    regex: /for\s+\w+\s+in\s+[\s\S]{0,300}?\.\w+_set\b|\.\w+\.all\(\)/,
    description: "Potential N+1 query — accessing related objects in loop without select_related/prefetch_related (Django)",
  },
  "late-binding": {
    regex: /for\s+(\w+)\s+in\s+[\s\S]{0,200}?lambda\s*[^:]*:\s*\1\b/,
    description: "Late binding closure in loop — all lambdas share last loop value (Python)",
  },
  "assert-tuple": {
    regex: /\bassert\s*\(/,
    description: "assert(expr) — always True because tuple is truthy. Use assert expr without parens (Python)",
  },
};

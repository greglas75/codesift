import type { BuiltinPatternDefinition } from "../types.js";

export const HONO_PATTERNS: Record<string, BuiltinPatternDefinition> = {
  // --- Hono anti-patterns (Task 15) ---
  "hono-missing-error-handler": {
    regex: /new\s+(?:Hono|OpenAPIHono)\s*(?:<[^>]*>)?\s*\(\s*\)(?!(?:[\s\S](?!new\s+(?:Hono|OpenAPIHono)))*\.onError)/,
    description: "Hono app created without .onError() handler — unhandled exceptions return 500 with no logging",
  },
  "hono-throw-raw-error": {
    regex: /\(\s*c\s*:\s*Context\s*(?:,\s*next\s*:\s*Next\s*)?\)[\s\S]*?\bthrow\s+new\s+Error\s*\(/,
    description: "throw new Error() inside Hono handler — use HTTPException for proper status code handling",
  },
  "hono-missing-validator": {
    regex: /await\s+c\.req\.(?:json|parseBody)\s*\(\s*\)(?![\s\S]{0,400}?zValidator)/,
    description: "c.req.json()/parseBody() without preceding zValidator — unvalidated request body",
  },
  "hono-unguarded-json-parse": {
    regex: /(?<!try\s*\{[\s\S]{0,200})await\s+c\.req\.json\s*\(\s*\)/,
    description: "await c.req.json() without try/catch — malformed JSON crashes handler",
  },
  "hono-env-type-any": {
    regex: /new\s+Hono\s*\(\s*\)(?!\s*<)/,
    description: "new Hono() without <Env> generic — loses type safety on c.env and c.var",
  },
  "hono-missing-status-code": {
    regex: /\bc\.json\s*\(\s*\{[^}]+\}\s*\)/,
    description: "c.json() without explicit status code — defaults to 200 even for errors/creations",
  },
  "hono-full-app-rpc-export": {
    regex: /export\s+type\s+\w+\s*=\s*typeof\s+app\b/,
    description: "export type X = typeof app — slow RPC pattern (Issue #3869, 8-min CI builds). Use typeof routeGroup instead",
  },
};

/**
 * Legacy regex-based Hono convention extractor.
 * Preserved as a kill-switch fallback (CODESIFT_LEGACY_HONO=1) during
 * the migration to the tree-sitter AST extractor.
 *
 * This file is a verbatim copy of the original regex functions from
 * project-tools.ts as of 2026-04-10 (pre-AST migration).
 *
 * DO NOT MODIFY — this is the frozen legacy implementation.
 * Delete after 2-week migration window per spec rollback strategy.
 */

import type { Conventions, MiddlewareChain, RateLimitEntry, RouteMountEntry } from "./project-tools.js";

interface HonoCall {
  type: "use" | "route" | "get" | "post" | "put" | "delete" | "all";
  path: string | null;
  args: string;
  line: number;
}

function parseHonoCalls(source: string): HonoCall[] {
  const calls: HonoCall[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;
    const useMatch = line.match(/app\.(use|route|get|post|put|delete|all)\s*\(\s*["']([^"']+)["']\s*,\s*(.+)/);
    if (useMatch) {
      const args = useMatch[3]!.trim().replace(/\);?\s*$/, "").trim();
      calls.push({ type: useMatch[1]! as HonoCall["type"], path: useMatch[2]!, args, line: lineNum });
      continue;
    }
    const globalUseMatch = line.match(/app\.use\s*\(\s*["']\*["']\s*,\s*(.+)/);
    if (globalUseMatch) {
      const args = globalUseMatch[1]!.trim().replace(/\);?\s*$/, "").trim();
      calls.push({ type: "use", path: "*", args, line: lineNum });
      continue;
    }
    const inlineMatch = line.match(/app\.(get|post|put|delete)\s*\(\s*["']([^"']+)["']\s*,/);
    if (inlineMatch) {
      calls.push({ type: inlineMatch[1]! as HonoCall["type"], path: inlineMatch[2]!, args: "(inline handler)", line: lineNum });
    }
  }
  return calls;
}

function extractMiddlewareName(args: string): string | null {
  const funcCall = args.match(/^(\w+)\s*\(/);
  if (funcCall) return funcCall[1]!;
  const simple = args.match(/^(\w+)$/);
  if (simple) return simple[1]!;
  return null;
}

function extractRateLimit(args: string): { max: number; window: number } | null {
  const match = args.match(/rateLimit\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (match) return { max: parseInt(match[1]!), window: parseInt(match[2]!) };
  return null;
}

function inferScope(path: string): string {
  if (path === "*") return "global";
  if (path.includes("/admin")) return "admin";
  if (path.includes("/webhook")) return "webhook";
  if (path.includes("/health")) return "health";
  if (path.includes("/public") || path.includes("/contests") || path.includes("/translations") || path.includes("/r/")) return "public";
  const segments = path.split("/").filter(Boolean);
  if (segments.length >= 2) return segments[1]!;
  return "root";
}

export function legacyExtractHonoConventions(source: string, filePath: string): Conventions {
  const calls = parseHonoCalls(source);
  const importMap = new Map<string, string>();
  for (const line of source.split("\n")) {
    const defaultImport = line.match(/import\s+(\w+)\s+from\s+["']([^"']+)["']/);
    if (defaultImport) importMap.set(defaultImport[1]!, defaultImport[2]!);
    const namedImport = line.match(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/);
    if (namedImport) {
      const names = namedImport[1]!.split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim());
      for (const name of names) importMap.set(name, namedImport[2]!);
    }
  }

  const middleware_chains: MiddlewareChain[] = [];
  const rate_limits: RateLimitEntry[] = [];
  const route_mounts: RouteMountEntry[] = [];
  const authGroups: Record<string, { requires_auth: boolean; middleware: string[] }> = {};
  let auth_middleware: string | null = null;
  const scopeChains = new Map<string, { name: string; line: number; order: number }[]>();
  const scopeMwSeen = new Map<string, Set<string>>();
  let globalOrder = 0;
  const scopeOrders = new Map<string, number>();

  for (const call of calls) {
    if (call.type === "use") {
      const mwName = extractMiddlewareName(call.args);
      const rl = extractRateLimit(call.args);
      if (rl) {
        rate_limits.push({ file: filePath, line: call.line, max: rl.max, window: rl.window, applied_to_path: call.path !== "*" ? call.path : null, method: null });
      } else if (mwName) {
        const scope = call.path === "*" ? "global" : inferScope(call.path ?? "");
        if (!scopeMwSeen.has(scope)) scopeMwSeen.set(scope, new Set());
        const seen = scopeMwSeen.get(scope)!;
        if (!seen.has(mwName)) {
          seen.add(mwName);
          const currentOrder = scope === "global" ? ++globalOrder : (scopeOrders.set(scope, (scopeOrders.get(scope) ?? 0) + 1), scopeOrders.get(scope)!);
          if (!scopeChains.has(scope)) scopeChains.set(scope, []);
          scopeChains.get(scope)!.push({ name: mwName, line: call.line, order: currentOrder });
        }
        if (/auth|clerk|jwt|session|passport/i.test(mwName)) {
          auth_middleware = mwName;
          const group = inferScope(call.path ?? "");
          if (!authGroups[group]) authGroups[group] = { requires_auth: false, middleware: [] };
          authGroups[group].requires_auth = true;
          if (!authGroups[group].middleware.includes(mwName)) authGroups[group].middleware.push(mwName);
        } else if (scope !== "global") {
          const group = scope;
          if (!authGroups[group]) authGroups[group] = { requires_auth: false, middleware: [] };
          if (!authGroups[group].middleware.includes(mwName)) authGroups[group].middleware.push(mwName);
        }
      }
    } else if (call.type === "route") {
      const varName = call.args.trim();
      route_mounts.push({ file: filePath, line: call.line, mount_path: call.path ?? "", imported_from: importMap.get(varName) ?? null, exported_as: varName });
      const group = inferScope(call.path ?? "");
      if (!authGroups[group]) authGroups[group] = { requires_auth: false, middleware: [] };
    }
  }

  for (const [scope, chain] of scopeChains) {
    middleware_chains.push({ scope, file: filePath, chain });
  }

  const routeGroups = new Set<string>();
  for (const mount of route_mounts) routeGroups.add(inferScope(mount.mount_path));
  for (const call of calls) {
    if (call.type !== "use" && call.type !== "route" && call.path) routeGroups.add(inferScope(call.path));
  }
  for (const group of routeGroups) {
    if (!authGroups[group]) authGroups[group] = { requires_auth: false, middleware: [] };
  }

  return { middleware_chains, rate_limits, route_mounts, auth_patterns: { auth_middleware, groups: authGroups } };
}

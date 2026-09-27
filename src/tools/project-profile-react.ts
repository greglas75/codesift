import type { CodeSymbol } from "../types.js";
import type { ReactConventions } from "./project-profile-types.js";

/** Detect the state-management library from dependencies (first match wins). */
export function detectStateManagement(deps: Record<string, string>): string | null {
  if (deps["@reduxjs/toolkit"] || deps["redux"]) return "redux";
  if (deps["zustand"]) return "zustand";
  if (deps["jotai"]) return "jotai";
  if (deps["recoil"]) return "recoil";
  if (deps["mobx"]) return "mobx";
  return null;
}

/** Detect the router library from dependencies (first match wins). */
export function detectRouting(deps: Record<string, string>): string | null {
  if (deps["react-router-dom"] || deps["react-router"]) return "react-router";
  if (deps["@tanstack/react-router"]) return "tanstack-router";
  if (deps["wouter"]) return "wouter";
  return null;
}

/**
 * Detect the UI library. shadcn/ui is checked FIRST via its canonical
 * components/ui/*.tsx path pattern so it takes precedence over a generic radix
 * dep (shadcn re-exports radix).
 */
export function detectUiLibrary(
  files: { path: string }[],
  deps: Record<string, string>,
): string | null {
  const hasShadcnFiles = files.some((f) =>
    /(^|\/)components\/ui\/[a-z-]+\.(tsx|jsx)$/.test(f.path)
  );
  if (hasShadcnFiles) return "shadcn";
  if (deps["@mui/material"]) return "mui";
  if (deps["@chakra-ui/react"]) return "chakra";
  if (deps["antd"]) return "antd";
  if (deps["@radix-ui/react-dialog"] || deps["@radix-ui/themes"]) return "radix";
  if (deps["tailwindcss"]) return "tailwind";
  return null;
}

/** Detect the form library from dependencies (first match wins). */
export function detectFormLibrary(deps: Record<string, string>): string | null {
  if (deps["react-hook-form"]) return "react-hook-form";
  if (deps["formik"]) return "formik";
  if (deps["final-form"] || deps["react-final-form"]) return "final-form";
  return null;
}

/** Coarse, file-path-based counts of pages / components / hooks. */
export function countComponentsByPath(
  files: { path: string }[],
): { pages: number; components: number; hooks: number } {
  let pages = 0, components = 0, hooks = 0;
  for (const f of files) {
    if (/\/pages?\//.test(f.path) && /\.(tsx|jsx)$/.test(f.path)) pages++;
    else if (/\/components?\//.test(f.path) && /\.(tsx|jsx)$/.test(f.path)) components++;
    if (/\/hooks?\//.test(f.path) || /\.hook\.(ts|js)$/.test(f.path)) hooks++;
  }
  return { pages, components, hooks };
}

export interface ReactSymbolStats {
  actual_component_count: number;
  actual_hook_count: number;
  hook_usage: Array<{ name: string; count: number }>;
  component_patterns: { memo: number; forwardRef: number; lazy: number };
}

/**
 * Symbol-based semantic stats (requires the Wave 1 extractor to populate
 * `symbols`): real component/hook counts, wrapper-pattern counts, and the
 * top-10 most-used hooks aggregated across component bodies.
 */
export function collectSymbolStats(symbols?: CodeSymbol[]): ReactSymbolStats {
  let actual_component_count = 0;
  let actual_hook_count = 0;
  const hookUsageMap = new Map<string, number>();
  const component_patterns = { memo: 0, forwardRef: 0, lazy: 0 };

  if (symbols) {
    for (const sym of symbols) {
      if (sym.kind === "component") {
        actual_component_count++;
        if (sym.source) {
          // Generic-aware wrapper patterns: memo<Props>(...), forwardRef<T, P>(...), lazy<T>(...)
          if (/\b(?:React\.)?memo\s*(?:<[^>]+>)?\s*\(/.test(sym.source)) component_patterns.memo++;
          if (/\b(?:React\.)?forwardRef\s*(?:<[^>]+>)?\s*\(/.test(sym.source)) component_patterns.forwardRef++;
          if (/\b(?:React\.)?lazy\s*(?:<[^>]+>)?\s*\(/.test(sym.source)) component_patterns.lazy++;
          // Count hook calls inside this component's source
          const hookCalls = sym.source.matchAll(/\b(use[A-Z]\w*)\s*\(/g);
          for (const m of hookCalls) {
            const hookName = m[1]!;
            hookUsageMap.set(hookName, (hookUsageMap.get(hookName) ?? 0) + 1);
          }
        }
      } else if (sym.kind === "hook") {
        actual_hook_count++;
      }
    }
  }

  const hook_usage = [...hookUsageMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  return { actual_component_count, actual_hook_count, hook_usage, component_patterns };
}

/**
 * Aggregate React project conventions from files, dependencies, and (optionally)
 * extracted symbols. Thin orchestrator over the focused detectors above.
 */
export function extractReactConventions(
  files: { path: string }[],
  deps: Record<string, string>,
  symbols?: CodeSymbol[],
): ReactConventions {
  const component_count = countComponentsByPath(files);
  const { actual_component_count, actual_hook_count, hook_usage, component_patterns } =
    collectSymbolStats(symbols);

  return {
    state_management: detectStateManagement(deps),
    routing: detectRouting(deps),
    ui_library: detectUiLibrary(files, deps),
    form_library: detectFormLibrary(deps),
    component_count,
    actual_component_count,
    actual_hook_count,
    hook_usage,
    component_patterns,
  };
}

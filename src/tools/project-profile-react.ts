import type { CodeSymbol } from "../types.js";
import type { ReactConventions } from "./project-profile-types.js";

export function extractReactConventions(
  files: { path: string }[],
  deps: Record<string, string>,
  symbols?: CodeSymbol[],
): ReactConventions {
  // State management
  let state_management: string | null = null;
  if (deps["@reduxjs/toolkit"] || deps["redux"]) state_management = "redux";
  else if (deps["zustand"]) state_management = "zustand";
  else if (deps["jotai"]) state_management = "jotai";
  else if (deps["recoil"]) state_management = "recoil";
  else if (deps["mobx"]) state_management = "mobx";

  // Routing
  let routing: string | null = null;
  if (deps["react-router-dom"] || deps["react-router"]) routing = "react-router";
  else if (deps["@tanstack/react-router"]) routing = "tanstack-router";
  else if (deps["wouter"]) routing = "wouter";

  // UI library
  // shadcn/ui detection: canonical path pattern is components/ui/*.tsx — checked
  // FIRST so it takes precedence over generic radix dep (shadcn re-exports radix).
  const hasShadcnFiles = files.some((f) =>
    /(^|\/)components\/ui\/[a-z-]+\.(tsx|jsx)$/.test(f.path)
  );
  let ui_library: string | null = null;
  if (hasShadcnFiles) ui_library = "shadcn";
  else if (deps["@mui/material"]) ui_library = "mui";
  else if (deps["@chakra-ui/react"]) ui_library = "chakra";
  else if (deps["antd"]) ui_library = "antd";
  else if (deps["@radix-ui/react-dialog"] || deps["@radix-ui/themes"]) ui_library = "radix";
  else if (deps["tailwindcss"]) ui_library = "tailwind";

  // Form library detection (Item 7)
  let form_library: string | null = null;
  if (deps["react-hook-form"]) form_library = "react-hook-form";
  else if (deps["formik"]) form_library = "formik";
  else if (deps["final-form"] || deps["react-final-form"]) form_library = "final-form";

  // File-path-based component counts (legacy, coarse)
  let pages = 0, components = 0, hooks = 0;
  for (const f of files) {
    if (/\/pages?\//.test(f.path) && /\.(tsx|jsx)$/.test(f.path)) pages++;
    else if (/\/components?\//.test(f.path) && /\.(tsx|jsx)$/.test(f.path)) components++;
    if (/\/hooks?\//.test(f.path) || /\.hook\.(ts|js)$/.test(f.path)) hooks++;
  }

  // Symbol-based semantic counts (requires Wave 1 extractor)
  let actual_component_count = 0;
  let actual_hook_count = 0;
  const hookUsageMap = new Map<string, number>();
  const component_patterns = { memo: 0, forwardRef: 0, lazy: 0 };

  if (symbols) {
    // Set of stdlib hooks to exclude from "hook usage" tracking — we want
    // to highlight which library/custom hooks components consume.
    for (const sym of symbols) {
      if (sym.kind === "component") {
        actual_component_count++;
        if (sym.source) {
          // Detect wrapper patterns in component source
          // Generic-aware patterns: memo<Props>(...), forwardRef<T, P>(...), lazy<T>(...) — Item 9
          if (/\b(?:React\.)?memo\s*(?:<[^>]+>)?\s*\(/.test(sym.source)) component_patterns.memo++;
          if (/\b(?:React\.)?forwardRef\s*(?:<[^>]+>)?\s*\(/.test(sym.source)) component_patterns.forwardRef++;
          if (/\b(?:React\.)?lazy\s*(?:<[^>]+>)?\s*\(/.test(sym.source)) component_patterns.lazy++;
          // Count hook calls inside this component
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

  return {
    state_management,
    routing,
    ui_library,
    form_library,
    component_count: { pages, components, hooks },
    actual_component_count,
    actual_hook_count,
    hook_usage,
    component_patterns,
  };
}

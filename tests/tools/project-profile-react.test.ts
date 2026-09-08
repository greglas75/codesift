import { describe, it, expect } from "vitest";
import type { CodeSymbol } from "../../src/types.js";
import {
  detectStateManagement,
  detectRouting,
  detectUiLibrary,
  detectFormLibrary,
  countComponentsByPath,
  collectSymbolStats,
} from "../../src/tools/project-profile-react.js";

const comp = (source?: string): CodeSymbol =>
  ({ kind: "component", ...(source !== undefined ? { source } : {}) } as unknown as CodeSymbol);
const hook = (): CodeSymbol => ({ kind: "hook" } as unknown as CodeSymbol);

describe("detectStateManagement", () => {
  it("detects redux from @reduxjs/toolkit or redux", () => {
    expect(detectStateManagement({ "@reduxjs/toolkit": "^2" })).toBe("redux");
    expect(detectStateManagement({ redux: "^4" })).toBe("redux");
  });
  it("detects zustand, jotai, recoil, mobx", () => {
    expect(detectStateManagement({ zustand: "^4" })).toBe("zustand");
    expect(detectStateManagement({ jotai: "^2" })).toBe("jotai");
    expect(detectStateManagement({ recoil: "^0" })).toBe("recoil");
    expect(detectStateManagement({ mobx: "^6" })).toBe("mobx");
  });
  it("returns null when no state lib present", () => {
    expect(detectStateManagement({ react: "^19" })).toBeNull();
  });
  it("redux takes precedence over zustand when both present", () => {
    expect(detectStateManagement({ redux: "^4", zustand: "^4" })).toBe("redux");
  });
});

describe("detectRouting", () => {
  it("detects react-router from react-router-dom or react-router", () => {
    expect(detectRouting({ "react-router-dom": "^6" })).toBe("react-router");
    expect(detectRouting({ "react-router": "^6" })).toBe("react-router");
  });
  it("detects tanstack-router and wouter", () => {
    expect(detectRouting({ "@tanstack/react-router": "^1" })).toBe("tanstack-router");
    expect(detectRouting({ wouter: "^3" })).toBe("wouter");
  });
  it("returns null when no router present", () => {
    expect(detectRouting({ react: "^19" })).toBeNull();
  });
  it("react-router takes precedence over wouter", () => {
    expect(detectRouting({ "react-router-dom": "^6", wouter: "^3" })).toBe("react-router");
  });
});

describe("detectUiLibrary", () => {
  const shadcnFile = [{ path: "src/components/ui/button.tsx" }];
  it("detects shadcn from components/ui/*.tsx path", () => {
    expect(detectUiLibrary(shadcnFile, {})).toBe("shadcn");
  });
  it("shadcn path takes precedence over radix, mui and tailwind deps", () => {
    expect(detectUiLibrary(shadcnFile, { "@radix-ui/themes": "^3" })).toBe("shadcn");
    expect(detectUiLibrary(shadcnFile, { "@mui/material": "^6" })).toBe("shadcn");
    expect(detectUiLibrary(shadcnFile, { tailwindcss: "^3" })).toBe("shadcn");
  });
  it("does NOT treat components/ui/*.ts (non-jsx) as shadcn", () => {
    expect(detectUiLibrary([{ path: "src/components/ui/button.ts" }], {})).toBeNull();
  });
  it("detects mui, chakra, antd, radix, tailwind from deps", () => {
    expect(detectUiLibrary([], { "@mui/material": "^6" })).toBe("mui");
    expect(detectUiLibrary([], { "@chakra-ui/react": "^2" })).toBe("chakra");
    expect(detectUiLibrary([], { antd: "^5" })).toBe("antd");
    expect(detectUiLibrary([], { "@radix-ui/react-dialog": "^1" })).toBe("radix");
    expect(detectUiLibrary([], { tailwindcss: "^3" })).toBe("tailwind");
  });
  it("mui takes precedence over tailwind", () => {
    expect(detectUiLibrary([], { "@mui/material": "^6", tailwindcss: "^3" })).toBe("mui");
  });
  it("returns null when nothing matches", () => {
    expect(detectUiLibrary([], { react: "^19" })).toBeNull();
  });
});

describe("detectFormLibrary", () => {
  it("detects react-hook-form, formik, final-form", () => {
    expect(detectFormLibrary({ "react-hook-form": "^7" })).toBe("react-hook-form");
    expect(detectFormLibrary({ formik: "^2" })).toBe("formik");
    expect(detectFormLibrary({ "final-form": "^4" })).toBe("final-form");
  });
  it("maps react-final-form alias to final-form", () => {
    expect(detectFormLibrary({ "react-final-form": "^6" })).toBe("final-form");
  });
  it("returns null when no form lib present", () => {
    expect(detectFormLibrary({ react: "^19" })).toBeNull();
  });
  it("react-hook-form takes precedence over formik", () => {
    expect(detectFormLibrary({ "react-hook-form": "^7", formik: "^2" })).toBe("react-hook-form");
  });
});

describe("countComponentsByPath", () => {
  it("counts a .tsx page under /pages/", () => {
    expect(countComponentsByPath([{ path: "src/pages/Home.tsx" }])).toEqual({ pages: 1, components: 0, hooks: 0 });
  });
  it("counts a .tsx component under /components/", () => {
    expect(countComponentsByPath([{ path: "src/components/Button.tsx" }])).toEqual({ pages: 0, components: 1, hooks: 0 });
  });
  it("a /pages/ file is a page, not double-counted as a component (else-if)", () => {
    const r = countComponentsByPath([{ path: "src/pages/components/Widget.tsx" }]);
    expect(r.pages).toBe(1);
    expect(r.components).toBe(0);
  });
  it("counts hooks from /hooks/ dir and *.hook.ts naming", () => {
    expect(countComponentsByPath([{ path: "src/hooks/useAuth.ts" }]).hooks).toBe(1);
    expect(countComponentsByPath([{ path: "src/lib/session.hook.ts" }]).hooks).toBe(1);
  });
  it("ignores non-jsx page/component files", () => {
    expect(countComponentsByPath([{ path: "src/pages/readme.md" }])).toEqual({ pages: 0, components: 0, hooks: 0 });
  });
});

describe("collectSymbolStats", () => {
  it("returns zeros and empty usage when symbols is undefined", () => {
    expect(collectSymbolStats(undefined)).toEqual({
      actual_component_count: 0,
      actual_hook_count: 0,
      hook_usage: [],
      component_patterns: { memo: 0, forwardRef: 0, lazy: 0 },
    });
  });
  it("counts components and hooks by kind (hook kind is NOT a component)", () => {
    const stats = collectSymbolStats([comp(), comp(), hook()]);
    expect(stats.actual_component_count).toBe(2);
    expect(stats.actual_hook_count).toBe(1);
  });
  it("detects memo, forwardRef and lazy wrapper patterns (incl. generics)", () => {
    const stats = collectSymbolStats([
      comp("export const A = memo<Props>((p) => null)"),
      comp("export const B = React.forwardRef<HTMLDivElement, P>((p, r) => null)"),
      comp("export const C = lazy(() => import('./C'))"),
    ]);
    expect(stats.component_patterns).toEqual({ memo: 1, forwardRef: 1, lazy: 1 });
  });
  it("aggregates hook usage and sorts by count descending", () => {
    const stats = collectSymbolStats([comp("function C(){ useBeta(); useBeta(); useBeta(); useAlpha(); }")]);
    expect(stats.hook_usage[0]).toEqual({ name: "useBeta", count: 3 });
    expect(stats.hook_usage[1]).toEqual({ name: "useAlpha", count: 1 });
  });
  it("truncates hook_usage to the top 10", () => {
    const calls = Array.from({ length: 12 }, (_, i) => `useH${i}();`).join(" ");
    const stats = collectSymbolStats([comp(`function C(){ ${calls} }`)]);
    expect(stats.hook_usage.length).toBe(10);
  });
});

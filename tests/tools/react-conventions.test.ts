import { describe, it, expect } from "vitest";
import { extractReactConventions } from "../../src/tools/project-tools.js";
import { BUILTIN_PATTERNS } from "../../src/tools/pattern-tools.js";

describe("extractReactConventions — shadcn/ui detection (Item 5)", () => {
  it("detects shadcn when components/ui/*.tsx files exist", () => {
    const files = [
      { path: "src/components/ui/button.tsx" },
      { path: "src/components/ui/dialog.tsx" },
      { path: "src/components/ui/card.tsx" },
    ];
    const result = extractReactConventions(files, { react: "^19.0.0" });
    expect(result.ui_library).toBe("shadcn");
  });

  it("detects shadcn at top-level components/ui (no src wrapper)", () => {
    const files = [{ path: "components/ui/button.tsx" }];
    const result = extractReactConventions(files, { react: "^19.0.0" });
    expect(result.ui_library).toBe("shadcn");
  });

  it("does NOT detect shadcn when components/ui has only .ts files", () => {
    const files = [
      { path: "src/components/ui/button.ts" },
      { path: "src/components/ui/dialog.ts" },
    ];
    const result = extractReactConventions(files, { react: "^19.0.0" });
    expect(result.ui_library).toBe(null);
  });

  it("shadcn takes precedence over @radix-ui dep (since shadcn re-exports radix)", () => {
    const files = [{ path: "src/components/ui/button.tsx" }];
    const result = extractReactConventions(files, {
      react: "^19.0.0",
      "@radix-ui/themes": "^3.0.0",
    });
    expect(result.ui_library).toBe("shadcn");
  });
});

describe("extractReactConventions — Tailwind detection (Item 6)", () => {
  it("detects tailwind as ui_library when tailwindcss dep present and no other UI lib", () => {
    const result = extractReactConventions([], {
      react: "^19.0.0",
      tailwindcss: "^3.4.0",
    });
    expect(result.ui_library).toBe("tailwind");
  });

  it("ui_library is null when no UI lib and no tailwindcss", () => {
    const result = extractReactConventions([], { react: "^19.0.0" });
    expect(result.ui_library).toBe(null);
  });

  it("shadcn (file pattern) takes precedence over tailwind dep", () => {
    const files = [{ path: "src/components/ui/button.tsx" }];
    const result = extractReactConventions(files, {
      react: "^19.0.0",
      tailwindcss: "^3.4.0",
    });
    expect(result.ui_library).toBe("shadcn");
  });

  it("mui takes precedence over tailwind", () => {
    const result = extractReactConventions([], {
      "@mui/material": "^6.0.0",
      tailwindcss: "^3.4.0",
    });
    expect(result.ui_library).toBe("mui");
  });
});

describe("extractReactConventions — form library detection (Item 7)", () => {
  it("detects react-hook-form when dep present", () => {
    const result = extractReactConventions([], { "react-hook-form": "^7.0.0" });
    expect(result.form_library).toBe("react-hook-form");
  });

  it("detects formik when dep present", () => {
    const result = extractReactConventions([], { formik: "^2.4.0" });
    expect(result.form_library).toBe("formik");
  });

  it("detects final-form when dep present", () => {
    const result = extractReactConventions([], { "final-form": "^4.0.0" });
    expect(result.form_library).toBe("final-form");
  });

  it("detects react-final-form alias as final-form", () => {
    const result = extractReactConventions([], { "react-final-form": "^6.0.0" });
    expect(result.form_library).toBe("final-form");
  });

  it("form_library is null when no form lib", () => {
    const result = extractReactConventions([], { react: "^19.0.0" });
    expect(result.form_library).toBe(null);
  });

  it("react-hook-form takes precedence over formik (most popular)", () => {
    const result = extractReactConventions([], {
      "react-hook-form": "^7.0.0",
      formik: "^2.4.0",
    });
    expect(result.form_library).toBe("react-hook-form");
  });
});

describe("forwardRef/memo generics regex (Item 9)", () => {
  // Tests the regex fix directly (used in symbol-tools.ts and project-tools.ts)
  const memoRe = /\b(?:React\.)?memo\s*(?:<[^>]+>)?\s*\(/;
  const forwardRefRe = /\b(?:React\.)?forwardRef\s*(?:<[^>]+>)?\s*\(/;
  const lazyRe = /\b(?:React\.)?lazy\s*(?:<[^>]+>)?\s*\(/;

  it("forwardRef matches with TypeScript generics", () => {
    expect(forwardRefRe.test("const Btn = forwardRef<HTMLButtonElement, Props>((p, r) => <button/>)")).toBe(true);
  });

  it("forwardRef matches React.forwardRef<T, P> form", () => {
    expect(forwardRefRe.test("const Btn = React.forwardRef<HTMLDivElement, MyProps>((p, r) => null)")).toBe(true);
  });

  it("forwardRef matches without generics (backward compat)", () => {
    expect(forwardRefRe.test("const Btn = forwardRef((p, r) => null)")).toBe(true);
  });

  it("memo matches with TypeScript generics", () => {
    expect(memoRe.test("const Btn = memo<MyProps>((p) => <div/>)")).toBe(true);
  });

  it("memo matches React.memo without generics", () => {
    expect(memoRe.test("const Btn = React.memo((p) => <div/>)")).toBe(true);
  });

  it("lazy matches without generics (typically no generics on lazy)", () => {
    expect(lazyRe.test("const Btn = lazy(() => import('./Btn'))")).toBe(true);
  });
});

describe("audit_scan REACT gate prerequisites (Item 11)", () => {
  it("BUILTIN_PATTERNS contains all 5 React patterns the audit gate uses", () => {
    // Precondition: React audit gate references these pattern names. If any
    // were renamed or removed, the gate would silently produce no findings.
    expect(BUILTIN_PATTERNS["hook-in-condition"]).toBeDefined();
    expect(BUILTIN_PATTERNS["useEffect-async"]).toBeDefined();
    expect(BUILTIN_PATTERNS["dangerously-set-html"]).toBeDefined();
    expect(BUILTIN_PATTERNS["index-as-key"]).toBeDefined();
    expect(BUILTIN_PATTERNS["nested-component-def"]).toBeDefined();
  });

  it("each React audit pattern has a non-empty description", () => {
    const patterns = ["hook-in-condition", "useEffect-async", "dangerously-set-html", "index-as-key", "nested-component-def"];
    for (const p of patterns) {
      expect(BUILTIN_PATTERNS[p]?.description.length).toBeGreaterThan(10);
    }
  });
});

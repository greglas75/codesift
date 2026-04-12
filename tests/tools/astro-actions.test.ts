import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeIndex, FileEntry } from "../../src/types.js";
import { initParser } from "../../src/parser/parser-manager.js";
import { auditAstroActionsFromIndex } from "../../src/tools/astro-actions.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = join(tmpdir(), "codesift-astro-actions-test");

let fixtureCounter = 0;

function createFixtureDir(files: Record<string, string>): string {
  const dir = join(TMP_ROOT, `run-${Date.now()}-${fixtureCounter++}`);
  mkdirSync(dir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(dir, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function makeIndex(root: string, paths: string[]): CodeIndex {
  const files: FileEntry[] = paths.map((p) => ({
    path: p,
    language: p.endsWith(".astro")
      ? "astro"
      : p.endsWith(".tsx")
        ? "tsx"
        : p.endsWith(".ts")
          ? "typescript"
          : "javascript",
    symbol_count: 0,
    last_modified: Date.now(),
  }));
  return {
    repo: "local/test",
    root,
    symbols: [],
    files,
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: 0,
    file_count: files.length,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initParser();
});

beforeEach(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ok */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("astroActionsAudit", () => {
  it("1. no actions file → empty result, score A", async () => {
    const root = createFixtureDir({});
    const index = makeIndex(root, []);

    const result = await auditAstroActionsFromIndex(index);

    expect(result.actions).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.anti_patterns_checked).toEqual([
      "AA01", "AA02", "AA03", "AA04", "AA05", "AA06",
    ]);
    expect(result.summary.total_actions).toBe(0);
    expect(result.summary.total_issues).toBe(0);
    expect(result.summary.score).toBe("A");
  });

  it("2. single valid action with z.object input → no issues, score A", async () => {
    const actions = `
import { defineAction } from "astro:actions";
import { z } from "astro:schema";

export const server = {
  greet: defineAction({
    accept: "json",
    input: z.object({
      name: z.string(),
    }),
    handler: async (input) => {
      return { message: "hello " + input.name };
    },
  }),
};
`;
    const root = createFixtureDir({ "src/actions/index.ts": actions });
    const index = makeIndex(root, ["src/actions/index.ts"]);

    const result = await auditAstroActionsFromIndex(index);

    expect(result.actions).toHaveLength(1);
    const act = result.actions[0]!;
    expect(act.name).toBe("greet");
    expect(act.accept).toBe("json");
    expect(act.has_input_schema).toBe(true);
    expect(act.input_fields).toEqual(["name"]);
    expect(result.issues).toEqual([]);
    expect(result.summary.score).toBe("A");
  });

  it("3. AA01: handler without return → error", async () => {
    const actions = `
import { defineAction } from "astro:actions";
import { z } from "astro:schema";

export const server = {
  broken: defineAction({
    input: z.object({ id: z.string() }),
    handler: async (input) => {
      console.log("got", input.id);
      // no return!
    },
  }),
};
`;
    const root = createFixtureDir({ "src/actions/index.ts": actions });
    const index = makeIndex(root, ["src/actions/index.ts"]);

    const result = await auditAstroActionsFromIndex(index);

    const aa01 = result.issues.filter((i) => i.code === "AA01");
    expect(aa01).toHaveLength(1);
    expect(aa01[0]!.severity).toBe("error");
    expect(aa01[0]!.action).toBe("broken");
  });

  it("4. AA02: .refine() on top-level schema → error", async () => {
    const actions = `
import { defineAction } from "astro:actions";
import { z } from "astro:schema";

export const server = {
  signup: defineAction({
    input: z
      .object({
        password: z.string(),
        confirm: z.string(),
      })
      .refine((v) => v.password === v.confirm, { message: "must match" }),
    handler: async (input) => {
      return { ok: true, user: input.password };
    },
  }),
};
`;
    const root = createFixtureDir({ "src/actions/index.ts": actions });
    const index = makeIndex(root, ["src/actions/index.ts"]);

    const result = await auditAstroActionsFromIndex(index);

    const aa02 = result.issues.filter((i) => i.code === "AA02");
    expect(aa02).toHaveLength(1);
    expect(aa02[0]!.severity).toBe("error");
    expect(aa02[0]!.action).toBe("signup");
  });

  it("5. AA03: .passthrough() usage → warning", async () => {
    const actions = `
import { defineAction } from "astro:actions";
import { z } from "astro:schema";

export const server = {
  loose: defineAction({
    input: z.object({ id: z.string() }).passthrough(),
    handler: async (input) => {
      return { id: input.id };
    },
  }),
};
`;
    const root = createFixtureDir({ "src/actions/index.ts": actions });
    const index = makeIndex(root, ["src/actions/index.ts"]);

    const result = await auditAstroActionsFromIndex(index);

    const aa03 = result.issues.filter((i) => i.code === "AA03");
    expect(aa03).toHaveLength(1);
    expect(aa03[0]!.severity).toBe("warning");
    expect(aa03[0]!.action).toBe("loose");
  });

  it("6. AA04: z.instanceof(File) without multipart form → error", async () => {
    const actions = `
import { defineAction } from "astro:actions";
import { z } from "astro:schema";

export const server = {
  upload: defineAction({
    accept: "form",
    input: z.object({
      file: z.instanceof(File),
      title: z.string(),
    }),
    handler: async (input) => {
      return { name: input.title };
    },
  }),
};
`;
    // Caller: a React component calling actions.upload() from inside a form
    // WITHOUT the multipart enctype.
    const caller = `
import { actions } from "astro:actions";

export function UploadForm() {
  return (
    <form method="POST" onSubmit={async (e) => {
      e.preventDefault();
      await actions.upload(new FormData(e.currentTarget));
    }}>
      <input type="file" name="file" />
      <button type="submit">Upload</button>
    </form>
  );
}
`;
    const root = createFixtureDir({
      "src/actions/index.ts": actions,
      "src/components/UploadForm.tsx": caller,
    });
    const index = makeIndex(root, [
      "src/actions/index.ts",
      "src/components/UploadForm.tsx",
    ]);

    const result = await auditAstroActionsFromIndex(index);

    const aa04 = result.issues.filter((i) => i.code === "AA04");
    expect(aa04.length).toBeGreaterThanOrEqual(1);
    expect(aa04[0]!.severity).toBe("error");
    expect(aa04[0]!.action).toBe("upload");
    expect(aa04[0]!.file).toBe("src/components/UploadForm.tsx");
  });

  it("7. AA06: client calls actions.foo() but action doesn't exist → error", async () => {
    const actions = `
import { defineAction } from "astro:actions";
import { z } from "astro:schema";

export const server = {
  greet: defineAction({
    input: z.object({ name: z.string() }),
    handler: async (input) => { return { greeting: "hi " + input.name }; },
  }),
};
`;
    const caller = `
import { actions } from "astro:actions";

export function Widget() {
  return (
    <button onClick={async () => {
      await actions.nonExistent({ foo: "bar" });
    }}>
      Click
    </button>
  );
}
`;
    const root = createFixtureDir({
      "src/actions/index.ts": actions,
      "src/components/Widget.tsx": caller,
    });
    const index = makeIndex(root, [
      "src/actions/index.ts",
      "src/components/Widget.tsx",
    ]);

    const result = await auditAstroActionsFromIndex(index);

    const aa06 = result.issues.filter((i) => i.code === "AA06");
    expect(aa06).toHaveLength(1);
    expect(aa06[0]!.severity).toBe("error");
    expect(aa06[0]!.action).toBe("nonExistent");
    expect(aa06[0]!.file).toBe("src/components/Widget.tsx");
  });

  it("8. mixed: 2 errors + 3 warnings → score C", async () => {
    // Actions file with:
    //  - AA01 error: missing return in handler 'a1'
    //  - AA02 error: top-level .refine() on 'a2'
    //  - AA03 warning: .passthrough() on 'a3'
    const actions = `
import { defineAction } from "astro:actions";
import { z } from "astro:schema";

export const server = {
  a1: defineAction({
    input: z.object({ x: z.string() }),
    handler: async () => {
      const noop = 1;
    },
  }),
  a2: defineAction({
    input: z.object({ p: z.string(), q: z.string() }).refine((v) => v.p !== v.q),
    handler: async () => {
      return { ok: true };
    },
  }),
  a3: defineAction({
    input: z.object({ id: z.string() }).passthrough(),
    handler: async () => {
      return { ok: true };
    },
  }),
  a4: defineAction({
    input: z.object({ name: z.string() }),
    handler: async () => {
      return { ok: true };
    },
  }),
};
`;
    // Caller:
    //  - AA05 warning: actions.a4() called from .astro frontmatter
    //  - AA05 warning: actions.a1() called from .astro frontmatter
    const pageAstro = `---
import { actions } from "astro:actions";

const r1 = await actions.a4({ name: "x" });
const r2 = await actions.a1({ x: "y" });
---
<html><body>ok</body></html>
`;
    const root = createFixtureDir({
      "src/actions/index.ts": actions,
      "src/pages/index.astro": pageAstro,
    });
    const index = makeIndex(root, [
      "src/actions/index.ts",
      "src/pages/index.astro",
    ]);

    const result = await auditAstroActionsFromIndex(index);

    const errors = result.issues.filter((i) => i.severity === "error");
    const warnings = result.issues.filter((i) => i.severity === "warning");

    expect(errors.length).toBe(2);
    expect(warnings.length).toBe(3);
    expect(result.summary.score).toBe("C");
  });
});

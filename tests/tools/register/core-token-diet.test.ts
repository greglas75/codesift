import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CORE_TOOL_ENTRIES } from "../../../src/register-tool-groups/core.js";
import { indexFolder } from "../../../src/register-tool-groups/deps.js";

/**
 * Task 4 (tool-runtime-opt plan) — token diet.
 * get_file_tree: compact-by-default (biggest token sink: 1.1M tok / 881 calls).
 * find_references: capped at max_refs=50 by default (#2 sink: 909K tok / 605 calls).
 */

function handlerFor(name: string) {
  const entry = CORE_TOOL_ENTRIES.find((e) => e.definition.name === name);
  if (!entry) throw new Error(`tool ${name} not registered`);
  return entry.definition.handler;
}

let dir: string;
let repo: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cs-token-diet-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "src", "callers"), { recursive: true });
  await mkdir(join(dir, "lib"), { recursive: true });

  // Declaration + a file in a second top-level dir so the NESTED tree really nests.
  await writeFile(join(dir, "src", "widget.ts"), "export function widget(): number { return 1; }\n");
  await writeFile(join(dir, "lib", "helper.ts"), "export const helper = 1;\n");

  // >50 references to `widget` so the default cap (50) truncates.
  for (let f = 0; f < 8; f++) {
    const calls = Array.from({ length: 8 }, () => "  widget();").join("\n");
    await writeFile(
      join(dir, "src", "callers", `c${f}.ts`),
      `import { widget } from "../widget.js";\nexport function run${f}(): void {\n${calls}\n}\n`,
    );
  }

  const res = (await indexFolder(dir)) as { repo?: string } | undefined;
  repo = res?.repo ?? `local/${dir.split("/").pop()}`;
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("get_file_tree — compact by default", () => {
  it("defaults to the flat compact list; compact:false still returns the nested tree", async () => {
    const handler = handlerFor("get_file_tree");

    const byDefault = String(await handler({ repo }));
    const explicitFull = String(await handler({ repo, compact: false }));

    // The nested tree indents children; the compact flat list does not.
    const indentedLines = (s: string) => s.split("\n").filter((l) => /^\s+\S/.test(l)).length;

    expect(indentedLines(explicitFull), "compact:false must still nest (indented lines)").toBeGreaterThan(0);
    expect(indentedLines(byDefault), "default must be the flat compact list (no indentation)").toBe(0);
    // Compact carries full paths on one line each — it must differ from the nested rendering.
    expect(byDefault).not.toBe(explicitFull);
  });
});

describe("find_references — capped by default", () => {
  it("caps at 50 with an overflow note; an explicit higher max_refs returns more", async () => {
    const handler = handlerFor("find_references");

    const capped = String(await handler({ repo, symbol_name: "widget" }));
    const raised = String(await handler({ repo, symbol_name: "widget", max_refs: 500 }));

    // Fixture has >50 refs, so the default must truncate and say so.
    expect(capped, "default must append the overflow note").toContain("more (pass max_refs to see more)");
    // Raising the cap above the true count removes the truncation entirely.
    expect(raised, "explicit high max_refs must not truncate").not.toContain("more (pass max_refs to see more)");
    expect(raised.length, "uncapped output must be larger than the capped one").toBeGreaterThan(capped.length);
  });
});

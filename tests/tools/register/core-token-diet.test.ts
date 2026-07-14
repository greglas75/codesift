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

  // max_refs reaches the handler as any finite number (zNum only guarantees finite).
  // Unvalidated, -1 made `refs.slice(0, -1)` silently DROP the last reference while
  // reporting `+${len+1} more`, and 2.5 printed `+7.5 more`. Clamp to a whole ≥ 0.
  it("clamps a negative / fractional max_refs instead of corrupting the output", async () => {
    const handler = handlerFor("find_references");
    const overflowCount = (s: string): number => {
      const m = /\+(\S+) more \(pass max_refs to see more\)/.exec(s);
      if (!m?.[1]) throw new Error(`no overflow note in output: ${s.slice(0, 200)}`);
      return Number(m[1]);
    };
    // formatRefsCompact renders either grouped ("  <line>: ctx" under a file header)
    // or flat ("file:line: ctx") when every file has exactly one ref.
    const shownRefs = (s: string): number =>
      s.split("\n").filter((l) => /^ {2}\d+: /.test(l) || /^\S+:\d+: /.test(l)).length;

    const neg = String(await handler({ repo, symbol_name: "widget", max_refs: -1 }));
    const zero = String(await handler({ repo, symbol_name: "widget", max_refs: 0 }));
    const frac = String(await handler({ repo, symbol_name: "widget", max_refs: 2.5 }));
    const two = String(await handler({ repo, symbol_name: "widget", max_refs: 2 }));

    // -1 clamps to 0: show nothing, report the TRUE total. Pre-fix, slice(0, -1)
    // silently dropped the last ref and the note read `+${total + 1} more`.
    expect(shownRefs(neg)).toBe(0);
    expect(overflowCount(neg)).toBe(overflowCount(zero));

    // 2.5 floors to 2: exactly 2 refs shown, and no `+7.5 more` nonsense.
    // (Only the COUNTS are compared — findReferences does not guarantee a stable
    // ref order across calls, so the specific 2 refs may differ run to run.)
    expect(shownRefs(frac)).toBe(2);
    expect(shownRefs(frac)).toBe(shownRefs(two));
    expect(overflowCount(frac)).toBe(overflowCount(two));

    for (const [label, out] of [["neg", neg], ["frac", frac]] as const) {
      const n = overflowCount(out);
      expect(Number.isInteger(n), `${label}: overflow count must be a whole number`).toBe(true);
      expect(n, `${label}: overflow count must be positive`).toBeGreaterThan(0);
    }
    // The true total is reported when nothing is shown; showing 2 hides exactly 2 fewer.
    expect(overflowCount(zero) - overflowCount(two)).toBe(2);
  });

  // The batch path fans out over MANY symbols — it used to return before any cap ran,
  // so max_refs was silently ignored on exactly the path that produces the most output.
  it("applies max_refs on the symbol_names BATCH path too (per symbol)", async () => {
    const handler = handlerFor("find_references");

    const batch = (await handler({ repo, symbol_names: ["widget"], max_refs: 3 })) as Record<string, unknown[]>;
    expect(Array.isArray(batch["widget"])).toBe(true);
    expect(batch["widget"]!.length).toBe(3); // fixture has >50 — capped per symbol

    // Default cap still applies with no explicit max_refs (fixture has >50 refs).
    const defaulted = (await handler({ repo, symbol_names: ["widget"] })) as Record<string, unknown[]>;
    expect(defaulted["widget"]!.length).toBe(50);
  });
});

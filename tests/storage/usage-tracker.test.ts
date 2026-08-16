import { buildArgsSummary, extractResultChunks, classifyError } from "../../src/storage/usage-tracker.js";

describe("buildArgsSummary", () => {
  describe("search_text field schema", () => {
    it("captures ranked flag (regression: telemetry blindspot)", () => {
      const s = buildArgsSummary("search_text", { query: "FooBar", ranked: true });
      expect(s["ranked"]).toBe(true);
    });

    it("captures explicit ranked=false", () => {
      const s = buildArgsSummary("search_text", { query: "FooBar", ranked: false });
      expect(s["ranked"]).toBe(false);
    });

    it("captures compact flag", () => {
      const s = buildArgsSummary("search_text", { query: "foo", compact: true });
      expect(s["compact"]).toBe(true);
    });

    it("omits ranked when not passed (so absent != false in logs)", () => {
      const s = buildArgsSummary("search_text", { query: "foo" });
      expect("ranked" in s).toBe(false);
      expect("compact" in s).toBe(false);
    });

    it("preserves all existing search_text fields alongside ranked/compact", () => {
      const s = buildArgsSummary("search_text", {
        query: "foo",
        regex: true,
        context_lines: 2,
        file_pattern: "*.ts",
        max_results: 10,
        group_by_file: true,
        auto_group: false,
        ranked: true,
        compact: false,
      });
      expect(s["query"]).toBe("foo");
      expect(s["regex"]).toBe(true);
      expect(s["context_lines"]).toBe(2);
      expect(s["file_pattern"]).toBe("*.ts");
      expect(s["max_results"]).toBe(10);
      expect(s["group_by_file"]).toBe(true);
      expect(s["auto_group"]).toBe(false);
      expect(s["ranked"]).toBe(true);
      expect(s["compact"]).toBe(false);
    });
  });
  describe("describe_tools names (regression: previously logged {})", () => {
    it("captures the requested tool names and count", () => {
      const s = buildArgsSummary("describe_tools", { names: ["find_dead_code", "rename_symbol"] });
      expect(s["names"]).toEqual(["find_dead_code", "rename_symbol"]);
      expect(s["name_count"]).toBe(2);
    });

    it("captures the reveal flag when present", () => {
      const s = buildArgsSummary("describe_tools", { names: ["find_dead_code"], reveal: true });
      expect(s["reveal"]).toBe(true);
    });

    it("caps names at 30 but keeps the full count", () => {
      const names = Array.from({ length: 50 }, (_, i) => `tool_${i}`);
      const s = buildArgsSummary("describe_tools", { names });
      expect((s["names"] as string[]).length).toBe(30);
      expect(s["name_count"]).toBe(50);
    });

    it("drops non-string entries defensively", () => {
      const s = buildArgsSummary("describe_tools", { names: ["ok", 123, null, "fine"] });
      expect(s["names"]).toEqual(["ok", "fine"]);
    });
  });
});

describe("extractResultChunks", () => {
  it("counts array results", () => {
    expect(extractResultChunks([1, 2, 3])).toBe(3);
  });

  it("counts non-empty lines of formatted-string results", () => {
    const formatted = "src/a.ts:10 function alpha\nsrc/b.ts:20 class Beta\n\nsrc/c.ts:5 type Gamma";
    expect(extractResultChunks(formatted)).toBe(3);
  });

  it("returns 0 for empty strings", () => {
    expect(extractResultChunks("")).toBe(0);
    expect(extractResultChunks("   \n  ")).toBe(0);
  });

  it("returns 0 for common no-result markers", () => {
    expect(extractResultChunks("(no results)")).toBe(0);
    expect(extractResultChunks("No matches.")).toBe(0);
    expect(extractResultChunks("no symbols found for query")).toBe(0);
  });

  it("still handles object results under common keys", () => {
    expect(extractResultChunks({ results: [1, 2] })).toBe(2);
    expect(extractResultChunks({ matches: [] })).toBe(0);
  });

  // find_references' batch path keys `references` by symbol name instead of returning an array.
  // The Array.isArray branch missed that shape and the whole call fell through to 0, so the
  // busiest path of a high-traffic tool logged "found nothing" on every call — and
  // empty_result_rate, which is derived from this number and shipped in the L1 payload, carried
  // the fiction outward. Counting zero for a result that is merely shaped differently is worse
  // than not measuring it, because nothing about the number says it is unmeasured.
  it("counts find_references' batch shape (references keyed by symbol name)", () => {
    expect(
      extractResultChunks({
        references: { alpha: [1, 2, 3], beta: [4] },
        scan_coverage: { status: "unknown" },
      }),
    ).toBe(4);
  });

  it("still reports 0 when a batch scan genuinely found nothing", () => {
    // The distinction the old code destroyed: a real miss and an unrecognised shape must not
    // produce the same number.
    expect(extractResultChunks({ references: {}, scan_coverage: { status: "complete" } })).toBe(0);
    expect(extractResultChunks({ references: { alpha: [], beta: [] } })).toBe(0);
  });

  it("keeps the array shape working for the single-symbol path", () => {
    expect(extractResultChunks({ references: [1, 2, 3] })).toBe(3);
  });
});

// `error: true` said a call failed and nothing else, so every past investigation had to
// reconstruct the cause from `repo`, `args_summary` and `elapsed_ms` — none of which name it. The
// class is stored; the MESSAGE is not, because it carries absolute paths, repo names and symbol
// names, and this file sits next to a telemetry uploader.
describe("classifyError", () => {
  it.each([
    ["ENOENT: no such file or directory, stat '/a/b.ts'", "file_missing"],
    ['No indexed repo contains "/tmp/x.ts". Run index_folder first.', "path_outside_repos"],
    ['Plan "plan_7" not found', "plan_not_found"],
    ['Symbol "useThing" not found in repository "local/x"', "symbol_not_found"],
    ['Repository "local/x" not found. Index it first with index_folder.', "repo_not_indexed"],
    ["Git diff failed: unknown revision or path not in the working tree", "git_failed"],
    ['Failed to parse "src/a.ts"', "parse_failed"],
    ["The operation was aborted due to timeout", "timeout"],
    ["symbol_name or symbol_names is required", "invalid_args"],
    ["something nobody has seen before", "other"],
  ])("classifies %j", (message, expected) => {
    expect(classifyError(message)).toBe(expected);
  });

  it("keeps the specific 'not found' faults apart from the generic one", () => {
    // Three different failures all say "not found" and each needs a different fix: index the repo,
    // index a different root, or stop asking for a symbol that is not there. Collapsing them is
    // how the log became undiagnosable in the first place.
    expect(classifyError('Symbol "x" not found in repository "r"')).toBe("symbol_not_found");
    expect(classifyError('Plan "p" not found')).toBe("plan_not_found");
    expect(classifyError('Repository "r" not found. Run index_folder first.')).toBe("repo_not_indexed");
  });

  it("never returns the message itself", () => {
    const secretish = 'Failed to parse "/Users/someone/private/thing.ts"';
    const cls = classifyError(secretish);
    expect(secretish).not.toContain(cls);
    expect(cls).toBe("parse_failed");
  });
});

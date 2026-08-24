import { describe, expect, it } from "vitest";
import { isCommentOnlyReference } from "../../src/tools/symbol-reference-tools.js";

/**
 * find_references matches text, so a symbol named in prose comes back beside its real callers.
 * Measured over 8 symbols in this repo: 45 of 314 references (14%) were comment mentions, and 21
 * of 50 for one heavily-documented symbol. The tokens are the smaller half — the result is capped
 * at max_refs, so mentions CONSUME slots that callers would fill.
 */
describe("isCommentOnlyReference", () => {
  it("flags a line-comment mention", () => {
    expect(isCommentOnlyReference("  // flag set by wrapTool")).toBe(true);
  });

  it("flags a docblock body and its opener", () => {
    expect(isCommentOnlyReference("   * deep under `wrapTool` — repo resolution")).toBe(true);
    expect(isCommentOnlyReference("/** wrapTool does X */")).toBe(true);
  });

  it("flags a hash comment (python, shell, yaml)", () => {
    expect(isCommentOnlyReference("# calls wrapTool")).toBe(true);
  });

  // The filter REMOVES results, so every uncertain case must fall on the keep side.
  it("keeps a code line that merely ends in a comment", () => {
    expect(isCommentOnlyReference("  wrapTool(name, args); // see above")).toBe(false);
  });

  it("keeps ordinary code, including a string that looks like a comment", () => {
    expect(isCommentOnlyReference("const url = 'https://x/y';")).toBe(false);
    expect(isCommentOnlyReference("import { wrapTool } from './x';")).toBe(false);
  });

  // A block comment whose continuation lines carry no leading star reads as code. That is a known
  // false negative and the deliberate direction: a kept mention costs tokens, a dropped caller
  // costs the answer.
  it("keeps an unmarked block-comment continuation rather than guessing", () => {
    expect(isCommentOnlyReference("   wrapTool is described here")).toBe(false);
  });
});

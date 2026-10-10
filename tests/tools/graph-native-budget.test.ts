// Bug it catches: the native call-graph cache was bounded by COUNT only, so two graphs of one large
// repo held 6.6 GB of Rust memory the V8 heap never saw (daemon RSS 11.9 GB, 2026-10-10).
import { describe, expect, it } from "vitest";
import { graphsOverBudget } from "../../src/tools/graph-native.js";

const GB = 1024 ** 3;
const e = (key: string, gb: number | undefined) => ({ key, bytes: gb === undefined ? undefined : gb * GB });

describe("graphsOverBudget", () => {
  it.each([
    ["everything fits", [e("a", 1), e("b", 1)], 4, []],
    ["two large graphs over budget drop the older", [e("old", 3.3), e("new", 3.3)], 4, ["old"]],
    ["drops oldest first until it fits", [e("a", 2), e("b", 2), e("c", 2), e("d", 1)], 4, ["a", "b"]],
    ["keeps the newest even when it alone exceeds the budget", [e("a", 1), e("big", 6)], 4, ["a"]],
    ["never drops a build in flight", [e("building", undefined), e("a", 3), e("b", 3)], 4, ["a"]],
    ["a single graph is never dropped", [e("only", 9)], 4, []],
  ])("%s", (_case, entries, budgetGb, expected) => {
    expect(graphsOverBudget(entries, budgetGb * GB)).toEqual(expected);
  });
});

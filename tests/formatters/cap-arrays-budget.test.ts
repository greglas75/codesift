import { describe, it, expect } from "vitest";
import { capArraysToBudget } from "../../src/formatters-shortening.js";

describe("capArraysToBudget", () => {
  it("returns the original object untouched when under budget", () => {
    const value = { items: [1, 2, 3], nested: { list: ["a", "b"] } };
    const result = capArraysToBudget(value, { budgetChars: 10_000 });
    expect(result).toBe(value); // identity — no copy
  });

  it("caps arrays deeply when over budget and keeps JSON valid", () => {
    const big = {
      routes: Array.from({ length: 500 }, (_, i) => ({
        path: `/api/resource-${i}`,
        method: "GET",
        handler: `Controller${i}.find`,
        guards: [`AuthGuard`, `RolesGuard`],
      })),
      summary: { total: 500 },
    };
    const result = capArraysToBudget(big, { budgetChars: 5_000 }) as {
      routes: unknown[];
      summary: { total: number };
    };
    expect(result).not.toBe(big);
    expect(result.summary.total).toBe(500); // scalars preserved
    expect(result.routes.length).toBeLessThan(500);
    const last = result.routes[result.routes.length - 1];
    expect(typeof last).toBe("string"); // truncation marker
    expect(String(last)).toContain("more items truncated");
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(JSON.stringify(result)!.length).toBeLessThanOrEqual(5_000);
  });

  it("never throws on circular structures", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc["self"] = cyc;
    expect(capArraysToBudget(cyc)).toBe(cyc);
  });

  it("returns the tightest cap as best effort when budget is unreachable", () => {
    const big = {
      one: ["x".repeat(2_000), "y".repeat(2_000), "z".repeat(2_000), "w".repeat(2_000)],
    };
    const result = capArraysToBudget(big, { budgetChars: 100 }) as { one: unknown[] };
    // 3-item cap floor: 3 entries + 1 marker
    expect(result.one.length).toBe(4);
  });
});

import { z } from "zod";
import { SubQuerySchema } from "../../src/retrieval/retrieval-schemas.js";

describe("conversation schema support", () => {
  it("SubQuerySchema parses conversation query type", () => {
    const result = SubQuerySchema.parse({
      type: "conversation",
      query: "auth bug fix",
    });
    expect(result.type).toBe("conversation");
  });

  it("SubQuerySchema accepts optional project and limit", () => {
    const result = SubQuerySchema.parse({
      type: "conversation",
      query: "caching decision",
      project: "my-project",
      limit: 10,
    });
    expect(result).toMatchObject({ type: "conversation", query: "caching decision", project: "my-project", limit: 10 });
  });

  it("SubQuerySchema rejects conversation query without query field", () => {
    expect(() => SubQuerySchema.parse({ type: "conversation" })).toThrow();
  });

  it("existing symbols query still parses (regression)", () => {
    const result = SubQuerySchema.parse({ type: "symbols", query: "foo" });
    expect(result.type).toBe("symbols");
  });
});

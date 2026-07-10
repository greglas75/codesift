import { describe, expect, it } from "vitest";
import { extractPrismaSymbols } from "../../src/parser/extractors/prisma.js";

describe("extractPrismaSymbols", () => {
  it("characterizes symbol identity and identifier tokens", () => {
    const source = [
      "// Account record",
      "model UserAccount {",
      "  id Int @id",
      "}",
    ].join("\n");

    expect(extractPrismaSymbols(source, "schema.prisma", "repo")).toMatchObject([
      {
        id: "repo:schema.prisma:UserAccount:2",
        name: "UserAccount",
        kind: "class",
        start_line: 2,
        end_line: 4,
        tokens: ["user", "account"],
        docstring: "// Account record",
      },
    ]);
  });
});

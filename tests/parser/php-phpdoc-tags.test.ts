import { describe, it, expect } from "vitest";
import {
  parsePhpDocTags,
  parsePhpDocVar,
} from "../../src/parser/extractors/php.js";

// Test level: small — pure in-process parsing with no I/O or timing.

describe("parsePhpDocTags", () => {
  it("returns empty array for undefined", () => {
    expect(parsePhpDocTags(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parsePhpDocTags("")).toEqual([]);
  });

  it("parses a single @property with type", () => {
    const doc = "/** @property int $id */";
    expect(parsePhpDocTags(doc)).toEqual([
      { tag: "property", name: "id", type: "int" },
    ]);
  });

  it("parses multiple @property tags", () => {
    const doc = `/**
 * @property string $name
 * @property Profile $profile
 */`;
    const tags = parsePhpDocTags(doc);
    expect(tags).toHaveLength(2);
    expect(tags[0]).toEqual({ tag: "property", name: "name", type: "string" });
    expect(tags[1]).toEqual({ tag: "property", name: "profile", type: "Profile" });
  });

  it("parses @method without return type", () => {
    const doc = "/** @method getPosts() */";
    const tags = parsePhpDocTags(doc);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.tag).toBe("method");
    expect(tags[0]?.name).toBe("getPosts");
    expect(tags[0]?.type).toBeUndefined();
  });

  it("parses @method with return type", () => {
    const doc = "/** @method ActiveQuery getUser(int $id) */";
    expect(parsePhpDocTags(doc)).toEqual([
      { tag: "method", name: "getUser", type: "ActiveQuery" },
    ]);
  });

  it("parses mixed @property and @method tags", () => {
    const doc = `/**
 * @property int $id
 * @property string $email
 * @method ActiveQuery getPosts()
 */`;
    const tags = parsePhpDocTags(doc);
    expect(tags).toHaveLength(3);
    expect(tags.find((t) => t.name === "id")?.tag).toBe("property");
    expect(tags.find((t) => t.name === "email")?.tag).toBe("property");
    expect(tags.find((t) => t.name === "getPosts")?.tag).toBe("method");
  });

  it("handles @property-read and @property-write variants", () => {
    const doc = `/**
 * @property-read int $id
 * @property-write string $password
 */`;
    const tags = parsePhpDocTags(doc);
    expect(tags).toHaveLength(2);
    expect(tags.map((t) => t.name).sort()).toEqual(["id", "password"]);
  });
});

describe("parsePhpDocVar", () => {
  it("returns undefined when the docblock is absent", () => {
    expect(parsePhpDocVar(undefined)).toBeUndefined();
  });

  it("returns undefined when the docblock has no @var tag", () => {
    expect(parsePhpDocVar("/** User display name. */")).toBeUndefined();
  });

  it("preserves nullable union syntax", () => {
    expect(parsePhpDocVar("/** @var User|null */")).toBe("User|null");
  });

  it("preserves array shorthand syntax", () => {
    expect(parsePhpDocVar("/** @var int[] */")).toBe("int[]");
  });
});

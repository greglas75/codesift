import { describe, it, expect } from "vitest";
import { parseFile } from "../../src/parser/parser-manager.js";
import { parseMetadataExport } from "../../src/utils/nextjs.js";

async function parse(source: string) {
  const tree = await parseFile("test.tsx", source);
  if (!tree) throw new Error("parseFile returned null");
  return tree;
}

describe("parseMetadataExport", () => {
  it("extracts static metadata with title and description", async () => {
    const src = `
export const metadata = {
  title: "Foo",
  description: "Bar",
};
`;
    const tree = await parse(src);
    const result = parseMetadataExport(tree, src);
    expect(result.title).toBe("Foo");
    expect(result.description).toBe("Bar");
  });

  it("extracts openGraph images from static metadata", async () => {
    const src = `
export const metadata = {
  title: "Hello",
  openGraph: {
    images: ["/og.png"],
  },
};
`;
    const tree = await parse(src);
    const result = parseMetadataExport(tree, src);
    expect(result.openGraph).toBeDefined();
    expect(result.openGraph?.images).toBeDefined();
    expect(result.openGraph?.images?.[0]).toBe("/og.png");
  });

  it("extracts fields from generateMetadata function return", async () => {
    const src = `
export async function generateMetadata() {
  return {
    title: "Dynamic Title",
    description: "Dynamic description text",
  };
}
`;
    const tree = await parse(src);
    const result = parseMetadataExport(tree, src);
    expect(result.title).toBe("Dynamic Title");
    expect(result.description).toBe("Dynamic description text");
  });

  it("returns empty object when no metadata export present", async () => {
    const src = `
export default function Page() {
  return <div>hello</div>;
}
`;
    const tree = await parse(src);
    const result = parseMetadataExport(tree, src);
    expect(result).toEqual({});
  });

  it("flags non-literal initializer with _non_literal marker", async () => {
    const src = `
const someExternal = buildMetadata();
export const metadata = someExternal;
`;
    const tree = await parse(src);
    const result = parseMetadataExport(tree, src);
    expect(result._non_literal).toBe(true);
  });

  it("extracts nested twitter card field", async () => {
    const src = `
export const metadata = {
  title: "Foo",
  twitter: {
    card: "summary_large_image",
  },
};
`;
    const tree = await parse(src);
    const result = parseMetadataExport(tree, src);
    expect(result.twitter).toBeDefined();
    expect(result.twitter?.card).toBe("summary_large_image");
  });
});

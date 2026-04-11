import { describe, it, expect } from "vitest";
import { parseFile } from "../../src/parser/parser-manager.js";
import {
  parseMetadataExport,
  extractFetchCalls,
} from "../../src/utils/nextjs.js";

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

describe("extractFetchCalls", () => {
  it("captures a single fetch call with null cacheOption", async () => {
    const src = `
async function load() {
  const res = await fetch('/api/data');
  return res;
}
`;
    const tree = await parse(src);
    const calls = extractFetchCalls(tree, src);
    const fetches = calls.filter((c) => c.callee === "fetch");
    expect(fetches.length).toBe(1);
    expect(fetches[0]!.cacheOption).toBeNull();
  });

  it("detects cache: no-store option as SSR trigger", async () => {
    const src = `
async function load() {
  const res = await fetch('/api/data', { cache: 'no-store' });
  return res;
}
`;
    const tree = await parse(src);
    const calls = extractFetchCalls(tree, src);
    const fetches = calls.filter((c) => c.callee === "fetch");
    expect(fetches.length).toBe(1);
    expect(fetches[0]!.cacheOption).toBe("no-store");
    expect(fetches[0]!.isSsrTrigger).toBe(true);
  });

  it("parses next.revalidate config into isr-{seconds}", async () => {
    const src = `
async function load() {
  const res = await fetch('/api/data', { next: { revalidate: 60 } });
  return res;
}
`;
    const tree = await parse(src);
    const calls = extractFetchCalls(tree, src);
    const fetches = calls.filter((c) => c.callee === "fetch");
    expect(fetches.length).toBe(1);
    expect(fetches[0]!.cacheOption).toBe("isr-60");
  });

  it("flags sequential awaits without shared identifier", async () => {
    const src = `
async function load() {
  const first = await fetch('/api/a');
  const second = await fetch('/api/b');
  return [first, second];
}
`;
    const tree = await parse(src);
    const calls = extractFetchCalls(tree, src);
    const fetches = calls.filter((c) => c.callee === "fetch");
    expect(fetches.length).toBe(2);
    expect(fetches[0]!.isSequential).toBe(false);
    expect(fetches[1]!.isSequential).toBe(true);
  });

  it("does not flag dependent awaits where second references first", async () => {
    const src = `
async function load() {
  const data = await fetch('/api/a');
  const more = await fetch(\`/api/b/\${data}\`);
  return more;
}
`;
    const tree = await parse(src);
    const calls = extractFetchCalls(tree, src);
    const fetches = calls.filter((c) => c.callee === "fetch");
    expect(fetches.length).toBe(2);
    expect(fetches[1]!.isSequential).toBe(false);
  });

  it("captures cookies() as dynamic trigger", async () => {
    const src = `
import { cookies } from 'next/headers';
async function load() {
  const jar = cookies();
  return jar.get('session');
}
`;
    const tree = await parse(src);
    const calls = extractFetchCalls(tree, src);
    const cookieCalls = calls.filter((c) => c.callee === "cookies");
    expect(cookieCalls.length).toBe(1);
    expect(cookieCalls[0]!.isSsrTrigger).toBe(true);
  });

  it("captures headers() as dynamic trigger", async () => {
    const src = `
import { headers } from 'next/headers';
async function load() {
  const h = headers();
  return h.get('x-custom');
}
`;
    const tree = await parse(src);
    const calls = extractFetchCalls(tree, src);
    const headerCalls = calls.filter((c) => c.callee === "headers");
    expect(headerCalls.length).toBe(1);
    expect(headerCalls[0]!.isSsrTrigger).toBe(true);
  });
});

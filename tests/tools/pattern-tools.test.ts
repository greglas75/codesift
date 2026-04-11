import { describe, it, expect, afterEach } from "vitest";
import { BUILTIN_PATTERNS, listPatterns, searchPatterns } from "../../src/tools/pattern-tools.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    delete process.env["CODESIFT_DATA_DIR"];
    resetConfigCache();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function createIndexedFixture(files: Record<string, string>): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-pattern-test-"));
  const projDir = join(tmpDir, "test-project");
  await mkdir(projDir, { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(projDir, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
  }
  await indexFolder(projDir, { watch: false });
  return "local/test-project";
}

describe("pattern-tools — React anti-patterns", () => {
  describe("hook-in-condition", () => {
    const regex = BUILTIN_PATTERNS["hook-in-condition"]!.regex;

    it("matches useState inside if block", () => {
      const source = `function Foo() {
  if (cond) {
    useState(0);
  }
}`;
      expect(regex.test(source)).toBe(true);
    });

    it("matches useEffect inside for loop", () => {
      const source = `for (const x of list) { useEffect(() => {}); }`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match hook at top level of function", () => {
      const source = `function Foo() {
  const [x, setX] = useState(0);
  return <div/>;
}`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("useEffect-async", () => {
    const regex = BUILTIN_PATTERNS["useEffect-async"]!.regex;

    it("matches async function directly in useEffect", () => {
      const source = `useEffect(async () => { await fetch(); }, []);`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match inner async wrapper", () => {
      const source = `useEffect(() => {
  async function load() { await fetch(); }
  load();
}, []);`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("useEffect-object-dep", () => {
    const regex = BUILTIN_PATTERNS["useEffect-object-dep"]!.regex;

    it("matches object literal in dependency array", () => {
      const source = `useEffect(() => { doThing(); }, [{ foo: 1 }]);`;
      expect(regex.test(source)).toBe(true);
    });

    it("matches array literal in dependency array", () => {
      const source = `useEffect(() => { doThing(); }, [[1, 2, 3]]);`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match identifier in dependency array", () => {
      const source = `useEffect(() => { doThing(); }, [count, name]);`;
      expect(regex.test(source)).toBe(false);
    });

    it("does not match empty dependency array", () => {
      const source = `useEffect(() => { doThing(); }, []);`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("missing-display-name", () => {
    const regex = BUILTIN_PATTERNS["missing-display-name"]!.regex;

    it("matches React.memo without displayName nearby", () => {
      const source = `const Button = React.memo(() => <button/>);
export default Button;`;
      expect(regex.test(source)).toBe(true);
    });

    it("matches forwardRef without displayName nearby", () => {
      const source = `const Input = forwardRef((props, ref) => <input ref={ref}/>);`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match when displayName is set", () => {
      const source = `const Button = React.memo(() => <button/>);
Button.displayName = 'Button';`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("index-as-key", () => {
    const regex = BUILTIN_PATTERNS["index-as-key"]!.regex;

    it("matches .map with index used as key", () => {
      const source = `items.map((item, index) => <Row key={index} data={item}/>)`;
      expect(regex.test(source)).toBe(true);
    });

    it("matches .map with idx used as key", () => {
      const source = `items.map((item, idx) => <Row key={idx}/>)`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match when id is used as key", () => {
      const source = `items.map((item, index) => <Row key={item.id}/>)`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("inline-handler", () => {
    const regex = BUILTIN_PATTERNS["inline-handler"]!.regex;

    it("matches inline arrow function in onClick", () => {
      const source = `<button onClick={() => setCount(c + 1)}>click</button>`;
      expect(regex.test(source)).toBe(true);
    });

    it("matches inline arrow function in onChange", () => {
      const source = `<input onChange={() => update()}/>`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match handler passed by reference", () => {
      const source = `<button onClick={handleClick}>click</button>`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("conditional-render-hook", () => {
    const regex = BUILTIN_PATTERNS["conditional-render-hook"]!.regex;

    it("matches hook after early return", () => {
      const source = `function Foo() {
  if (!user) return null;
  const [x, setX] = useState(0);
}`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match hook before any return", () => {
      const source = `function Foo() {
  const [x, setX] = useState(0);
  if (!user) return null;
  return <div/>;
}`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("dangerously-set-html", () => {
    const regex = BUILTIN_PATTERNS["dangerously-set-html"]!.regex;

    it("matches dangerouslySetInnerHTML usage", () => {
      const source = `<div dangerouslySetInnerHTML={{ __html: content }}/>`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match regular props", () => {
      const source = `<div className="box">{content}</div>`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("direct-dom-access", () => {
    const regex = BUILTIN_PATTERNS["direct-dom-access"]!.regex;

    it("matches document.getElementById", () => {
      const source = `const el = document.getElementById("root");`;
      expect(regex.test(source)).toBe(true);
    });

    it("matches document.querySelector", () => {
      const source = `document.querySelector(".modal");`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match useRef pattern", () => {
      const source = `const ref = useRef(null); ref.current.focus();`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("jsx-falsy-and", () => {
    const regex = BUILTIN_PATTERNS["jsx-falsy-and"]!.regex;

    it("matches count && <Component>", () => {
      const source = `{count && <UserList/>}`;
      expect(regex.test(source)).toBe(true);
    });

    it("matches length && <Component>", () => {
      const source = `{length && <Items/>}`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match boolean && <Component>", () => {
      const source = `{isReady && <Dashboard/>}`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("nested-component-def", () => {
    const regex = BUILTIN_PATTERNS["nested-component-def"]!.regex;

    it("matches component defined inside another component", () => {
      const source = `function ParentComponent() {
  const InnerComponent = () => {
    return <div>inner</div>;
  };
  return <InnerComponent/>;
}`;
      expect(regex.test(source)).toBe(true);
    });
  });

  describe("usecallback-no-deps", () => {
    const regex = BUILTIN_PATTERNS["usecallback-no-deps"]!.regex;

    it("matches useCallback without dependency array", () => {
      const source = `const handleClick = useCallback(() => doThing());`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match useCallback with deps", () => {
      const source = `const handleClick = useCallback(() => doThing(), [dep]);`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("listPatterns — React patterns registered", () => {
    it("includes all 14 React patterns", () => {
      const names = listPatterns().map((p) => p.name);
      // Wave 2 (7 patterns)
      expect(names).toContain("hook-in-condition");
      expect(names).toContain("useEffect-async");
      expect(names).toContain("useEffect-object-dep");
      expect(names).toContain("missing-display-name");
      expect(names).toContain("index-as-key");
      expect(names).toContain("inline-handler");
      expect(names).toContain("conditional-render-hook");
      // Wave 4b (6 additional patterns)
      expect(names).toContain("dangerously-set-html");
      expect(names).toContain("direct-dom-access");
      expect(names).toContain("unstable-default-value");
      expect(names).toContain("jsx-falsy-and");
      expect(names).toContain("nested-component-def");
      expect(names).toContain("usecallback-no-deps");
    });
  });
});

describe("pattern-tools — Astro anti-patterns", () => {
  describe("astro-client-on-astro", () => {
    const regex = BUILTIN_PATTERNS["astro-client-on-astro"]!.regex;

    it("matches client:load directive on .astro import", () => {
      const source = `<MyWidget client:load src="Widget.astro" />`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match client directive on .tsx component", () => {
      const source = `<MyWidget client:load src="Widget.tsx" />`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("astro-glob-usage", () => {
    const regex = BUILTIN_PATTERNS["astro-glob-usage"]!.regex;

    it("matches Astro.glob() call", () => {
      const source = `const posts = await Astro.glob('../posts/**/*.md');`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match import.meta.glob()", () => {
      const source = `const posts = import.meta.glob('../posts/**/*.md');`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("astro-set-html-xss", () => {
    const regex = BUILTIN_PATTERNS["astro-set-html-xss"]!.regex;

    it("matches set:html with dynamic variable", () => {
      const source = `<div set:html={userContent} />`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match set:html with a quoted string literal", () => {
      const source = `<div set:html={"<b>safe</b>"} />`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("astro-img-element", () => {
    const regex = BUILTIN_PATTERNS["astro-img-element"]!.regex;

    it("matches raw <img> element", () => {
      const source = `<img src="/logo.png" alt="logo" />`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match <Image> component", () => {
      const source = `<Image src="/logo.png" alt="logo" />`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("astro-missing-getStaticPaths", () => {
    const regex = BUILTIN_PATTERNS["astro-missing-getStaticPaths"]!.regex;

    it("matches dynamic route filename with bracket param", () => {
      const source = `// file: src/pages/posts/[slug].astro`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match static route filename", () => {
      const source = `// file: src/pages/posts/index.astro`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("astro-legacy-content-collections", () => {
    const regex = BUILTIN_PATTERNS["astro-legacy-content-collections"]!.regex;

    it("matches legacy src/content/config.ts path", () => {
      const source = `import { defineCollection } from 'src/content/config.ts';`;
      expect(regex.test(source)).toBe(true);
    });

    it("does not match new src/content.config.ts path", () => {
      const source = `import { defineCollection } from 'src/content.config.ts';`;
      expect(regex.test(source)).toBe(false);
    });
  });
});

describe("nextjs-wrong-router", () => {
  const pattern = BUILTIN_PATTERNS["nextjs-wrong-router"]!;

  it("regex matches next/router import", () => {
    const source = `import { useRouter } from "next/router";`;
    expect(pattern.regex.test(source)).toBe(true);
  });

  it("regex does not match next/navigation import", () => {
    const source = `import { useRouter } from "next/navigation";`;
    expect(pattern.regex.test(source)).toBe(false);
  });

  it("fileExcludePattern suppresses pages/ files", () => {
    expect(pattern.fileExcludePattern!.test("pages/index.tsx")).toBe(true);
    expect(pattern.fileExcludePattern!.test("pages/api/users.ts")).toBe(true);
  });

  it("fileExcludePattern does not suppress app/ files", () => {
    expect(pattern.fileExcludePattern!.test("app/page.tsx")).toBe(false);
    expect(pattern.fileExcludePattern!.test("app/components/Nav.tsx")).toBe(false);
  });

  it("suppressed on pages/ files in searchPatterns", async () => {
    const repo = await createIndexedFixture({
      // The source needs the import inline to be part of a symbol
      "pages/index.tsx": `export default function Home() {
  // Using wrong: from "next/router" import
  const source = 'from "next/router"';
  return null;
}`,
    });
    const result = await searchPatterns(repo, "nextjs-wrong-router");
    expect(result.matches).toHaveLength(0);
  });

  it("matches in app/ files in searchPatterns", async () => {
    const repo = await createIndexedFixture({
      "app/page.tsx": `export default function Home() {
  // Using wrong: from "next/router" import
  const source = 'from "next/router"';
  return null;
}`,
    });
    const result = await searchPatterns(repo, "nextjs-wrong-router");
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
  });
});

describe("nextjs-fetch-waterfall", () => {
  const pattern = BUILTIN_PATTERNS["nextjs-fetch-waterfall"]!;

  it("matches sequential await fetch calls", () => {
    const source = `async function getData() {
  const a = await fetch('/api/users');
  const b = await fetch('/api/posts');
  return { a, b };
}`;
    expect(pattern.regex.test(source)).toBe(true);
  });

  it("does not match single fetch call", () => {
    const source = `async function getData() {
  const a = await fetch('/api/users');
  return a;
}`;
    expect(pattern.regex.test(source)).toBe(false);
  });
});

describe("nextjs-unnecessary-use-client", () => {
  const pattern = BUILTIN_PATTERNS["nextjs-unnecessary-use-client"]!;

  it("matches file with use client but no hooks or events", () => {
    const source = `"use client";
export function Plain({ message }) {
  return <div>{message}</div>;
}`;
    expect(pattern.regex.test(source)).toBe(true);
  });

  it("does not match file with use client and useState", () => {
    const source = `"use client";
import { useState } from "react";
export function Btn() {
  const [c, setC] = useState(0);
  return <button onClick={() => setC(c+1)}>{c}</button>;
}`;
    expect(pattern.regex.test(source)).toBe(false);
  });
});

describe("nextjs-pages-in-app", () => {
  const pattern = BUILTIN_PATTERNS["nextjs-pages-in-app"]!;

  it("matches index.tsx inside app/ directory", () => {
    expect(pattern.fileIncludePattern!.test("app/index.tsx")).toBe(true);
    expect(pattern.fileIncludePattern!.test("app/users/index.tsx")).toBe(true);
  });

  it("does not match page.tsx inside app/ directory", () => {
    expect(pattern.fileIncludePattern!.test("app/page.tsx")).toBe(false);
    expect(pattern.fileIncludePattern!.test("app/users/page.tsx")).toBe(false);
  });
});

describe("nextjs-missing-error-boundary", () => {
  const pattern = BUILTIN_PATTERNS["nextjs-missing-error-boundary"]!;

  it("pattern exists with correct description", () => {
    expect(pattern.description).toContain("error");
  });

  it("fileIncludePattern matches page files in app/", () => {
    expect(pattern.fileIncludePattern!.test("app/products/page.tsx")).toBe(true);
  });
});

describe("nextjs-use-client-in-layout", () => {
  const pattern = BUILTIN_PATTERNS["nextjs-use-client-in-layout"]!;

  it("matches layout file with use client", () => {
    const source = `"use client";
export default function Layout({ children }) {
  return <div>{children}</div>;
}`;
    expect(pattern.regex.test(source)).toBe(true);
  });

  it("does not match layout file without directive", () => {
    const source = `export default function Layout({ children }) {
  return <div>{children}</div>;
}`;
    expect(pattern.regex.test(source)).toBe(false);
  });
});

describe("nextjs-missing-metadata", () => {
  const pattern = BUILTIN_PATTERNS["nextjs-missing-metadata"]!;

  it("pattern exists with correct description", () => {
    expect(pattern.description).toContain("metadata");
  });

  it("fileIncludePattern matches page files in app/", () => {
    expect(pattern.fileIncludePattern!.test("app/about/page.tsx")).toBe(true);
  });
});

describe("listPatterns", () => {
  it("includes fileExcludePattern when present", () => {
    const patterns = listPatterns();
    const wrongRouter = patterns.find((p) => p.name === "nextjs-wrong-router");
    expect(wrongRouter).toBeDefined();
    expect(wrongRouter!.fileExcludePattern).toBeDefined();
    expect(wrongRouter!.fileExcludePattern).toContain("pages");
  });

  it("includes all 7 hono patterns in BUILTIN_PATTERNS", () => {
    const patterns = listPatterns();
    const honoPatterns = patterns.filter((p) => p.name.startsWith("hono-"));
    expect(honoPatterns.length).toBe(7);
    const names = honoPatterns.map((p) => p.name).sort();
    expect(names).toEqual([
      "hono-env-type-any",
      "hono-full-app-rpc-export",
      "hono-missing-error-handler",
      "hono-missing-status-code",
      "hono-missing-validator",
      "hono-throw-raw-error",
      "hono-unguarded-json-parse",
    ]);
  });

  it("hono-full-app-rpc-export matches typeof app export (AC-P1)", () => {
    const pattern = BUILTIN_PATTERNS["hono-full-app-rpc-export"]!;
    expect(pattern.regex.test("export type AppType = typeof app;")).toBe(true);
    expect(pattern.regex.test("export type UserRoutes = typeof userRouter;")).toBe(false);
  });

  it("hono-unguarded-json-parse matches naked await c.req.json() (AC-P2)", () => {
    const pattern = BUILTIN_PATTERNS["hono-unguarded-json-parse"]!;
    expect(pattern.regex.test("const body = await c.req.json();")).toBe(true);
  });

  it("hono-env-type-any matches new Hono() without generic", () => {
    const pattern = BUILTIN_PATTERNS["hono-env-type-any"]!;
    expect(pattern.regex.test("const app = new Hono();")).toBe(true);
    expect(pattern.regex.test("const app = new Hono<Env>();")).toBe(false);
  });

  it("includes all 7 nextjs patterns plus existing patterns", () => {
    const patterns = listPatterns();
    const nextjsPatterns = patterns.filter((p) => p.name.startsWith("nextjs-"));
    expect(nextjsPatterns).toHaveLength(7);
    // Total should include all existing + 7 new nextjs patterns
    expect(patterns.length).toBeGreaterThanOrEqual(16); // 9 original + 7 nextjs
  });
});

describe("pattern-tools — Kotest anti-patterns", () => {
  describe("kotest-missing-assertion", () => {
    const regex = BUILTIN_PATTERNS["kotest-missing-assertion"]!.regex;

    it("matches an empty test block", () => {
      const source = `class UserSpec : FunSpec({
    test("validates email") { }
})`;
      expect(regex.test(source)).toBe(true);
    });

    it("matches a test block with only println (no assertion)", () => {
      const source = `class UserSpec : FunSpec({
    test("validates email") {
        val x = 5
        println(x)
    }
})`;
      expect(regex.test(source)).toBe(true);
    });

    it("does NOT match a test block containing shouldBe", () => {
      const source = `class UserSpec : FunSpec({
    test("validates email") {
        val x = 5
        x shouldBe 5
    }
})`;
      expect(regex.test(source)).toBe(false);
    });

    it("does NOT match a test block containing shouldThrow", () => {
      const source = `class UserSpec : FunSpec({
    test("rejects") {
        shouldThrow<IllegalArgumentException> { doThing() }
    }
})`;
      expect(regex.test(source)).toBe(false);
    });

    it("does NOT match a test block containing assertSoftly", () => {
      const source = `class UserSpec : FunSpec({
    test("multi") {
        assertSoftly {
            x shouldBe 1
            y shouldBe 2
        }
    }
})`;
      expect(regex.test(source)).toBe(false);
    });
  });

  describe("kotest-mixed-styles", () => {
    const regex = BUILTIN_PATTERNS["kotest-mixed-styles"]!.regex;

    it("matches a file containing both FunSpec and DescribeSpec", () => {
      const source = `class AppSpec : FunSpec({
    test("first") { shouldBe true }
})

class UserSpec : DescribeSpec({
    describe("user") { }
})`;
      expect(regex.test(source)).toBe(true);
    });

    it("matches a file containing both FunSpec and BehaviorSpec", () => {
      const source = `class AppSpec : FunSpec({ test("x") {} })
class OrderSpec : BehaviorSpec({ given("y") {} })`;
      expect(regex.test(source)).toBe(true);
    });

    it("does NOT match a file with only FunSpec classes", () => {
      const source = `class AppSpec : FunSpec({ test("x") {} })
class OtherSpec : FunSpec({ test("y") {} })`;
      expect(regex.test(source)).toBe(false);
    });

    it("does NOT match a file with only DescribeSpec", () => {
      const source = `class AppSpec : DescribeSpec({ describe("x") { it("y") {} } })`;
      expect(regex.test(source)).toBe(false);
    });

    it("does NOT match a non-Kotest Kotlin file", () => {
      const source = `class User(val name: String) { fun greet() = "Hi $name" }`;
      expect(regex.test(source)).toBe(false);
    });
  });
});

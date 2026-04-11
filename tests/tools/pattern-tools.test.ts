import { BUILTIN_PATTERNS, listPatterns } from "../../src/tools/pattern-tools.js";

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

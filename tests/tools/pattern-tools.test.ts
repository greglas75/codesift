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

  describe("listPatterns — React patterns registered", () => {
    it("includes all 8 new React patterns", () => {
      const names = listPatterns().map((p) => p.name);
      expect(names).toContain("hook-in-condition");
      expect(names).toContain("useEffect-async");
      expect(names).toContain("useEffect-object-dep");
      expect(names).toContain("missing-display-name");
      expect(names).toContain("index-as-key");
      expect(names).toContain("inline-handler");
      expect(names).toContain("conditional-render-hook");
    });
  });
});

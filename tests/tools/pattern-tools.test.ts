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

describe("pattern-tools — NestJS anti-patterns", () => {
  describe("nest-circular-inject", () => {
    const re = BUILTIN_PATTERNS["nest-circular-inject"]!.regex;
    it("matches @Inject(forwardRef(() => UserService))", () => {
      expect(re.test(`@Inject(forwardRef(() => UserService))`)).toBe(true);
    });
    it("does not match regular @Inject('TOKEN')", () => {
      expect(re.test(`@Inject('USER_REPO')`)).toBe(false);
    });
  });

  describe("nest-catch-all-filter", () => {
    const re = BUILTIN_PATTERNS["nest-catch-all-filter"]!.regex;
    it("matches @Catch() with no argument", () => {
      expect(re.test(`@Catch()\nexport class AllExceptionsFilter {`)).toBe(true);
    });
    it("does not match @Catch(HttpException)", () => {
      expect(re.test(`@Catch(HttpException)\nexport class HttpFilter {`)).toBe(false);
    });
  });

  describe("nest-request-scope", () => {
    const re = BUILTIN_PATTERNS["nest-request-scope"]!.regex;
    it("matches scope: Scope.REQUEST", () => {
      expect(re.test(`@Injectable({ scope: Scope.REQUEST })`)).toBe(true);
    });
    it("does not match scope: Scope.DEFAULT", () => {
      expect(re.test(`@Injectable({ scope: Scope.DEFAULT })`)).toBe(false);
    });
  });

  describe("nest-raw-exception", () => {
    const re = BUILTIN_PATTERNS["nest-raw-exception"]!.regex;
    it("matches throw new Error('message')", () => {
      expect(re.test(`throw new Error('Something went wrong');`)).toBe(true);
    });
    it("does not match throw new HttpException", () => {
      expect(re.test(`throw new HttpException('Not found', 404);`)).toBe(false);
    });
    it("does not match throw new BadRequestException", () => {
      expect(re.test(`throw new BadRequestException('Invalid');`)).toBe(false);
    });
  });

  describe("nest-any-guard-return", () => {
    const re = BUILTIN_PATTERNS["nest-any-guard-return"]!.regex;
    it("matches canActivate() { return true; }", () => {
      expect(re.test(`canActivate() {\n    return true;\n  }`)).toBe(true);
    });
    it("does not match canActivate with conditional return", () => {
      expect(re.test(`canActivate() {\n    return user.isAdmin;\n  }`)).toBe(false);
    });
    it("does not match canActivate returning false", () => {
      expect(re.test(`canActivate() {\n    return false;\n  }`)).toBe(false);
    });
  });

  describe("nest-service-locator", () => {
    const re = BUILTIN_PATTERNS["nest-service-locator"]!.regex;
    it("matches this.moduleRef.get(SomeService)", () => {
      expect(re.test(`this.moduleRef.get(SomeService)`)).toBe(true);
    });
    it("matches moduleRef.resolve(SomeService)", () => {
      expect(re.test(`this.moduleRef.resolve(SomeService)`)).toBe(true);
    });
    it("does not match regular service.getById()", () => {
      expect(re.test(`this.userService.getById(id)`)).toBe(false);
    });
  });

  describe("nest-direct-env", () => {
    const re = BUILTIN_PATTERNS["nest-direct-env"]!.regex;
    it("matches process.env.DATABASE_URL", () => {
      expect(re.test(`const url = process.env.DATABASE_URL;`)).toBe(true);
    });
    it("does not match configService.get('DATABASE_URL')", () => {
      expect(re.test(`const url = this.configService.get('DATABASE_URL');`)).toBe(false);
    });
  });

  describe("listPatterns includes NestJS patterns", () => {
    it("contains all 7 NestJS patterns", () => {
      const patterns = listPatterns();
      const nestPatterns = patterns.filter((p) => p.name.startsWith("nest-"));
      expect(nestPatterns.length).toBe(7);
    });

    it("each NestJS pattern has a description ending with (NestJS)", () => {
      const patterns = listPatterns();
      const nestPatterns = patterns.filter((p) => p.name.startsWith("nest-"));
      for (const p of nestPatterns) {
        expect(p.description).toContain("(NestJS)");
      }
    });
  });
});

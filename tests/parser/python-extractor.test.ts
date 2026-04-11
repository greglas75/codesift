import { describe, it, expect, beforeAll } from "vitest";
import { initParser, getParser } from "../../src/parser/parser-manager.js";
import { extractPythonSymbols } from "../../src/parser/extractors/python.js";

beforeAll(async () => {
  await initParser();
});

async function parsePython(source: string, file = "test.py") {
  const parser = await getParser("python");
  expect(parser).not.toBeNull();
  const tree = parser!.parse(source);
  return extractPythonSymbols(tree, file, source, "test-repo");
}

// --- Async functions ---

describe("extractPythonSymbols — async functions", () => {
  it("detects top-level async def", async () => {
    const symbols = await parsePython(`
async def fetch_user():
    pass
`);
    const fn = symbols.find((s) => s.name === "fetch_user");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.is_async).toBe(true);
  });

  it("sync def has no is_async flag", async () => {
    const symbols = await parsePython(`
def sync_fn():
    pass
`);
    const fn = symbols.find((s) => s.name === "sync_fn");
    expect(fn).toBeDefined();
    expect(fn!.is_async).toBeUndefined();
  });

  it("async method inside class carries is_async", async () => {
    const symbols = await parsePython(`
class Resource:
    async def __aenter__(self):
        return self
`);
    const m = symbols.find((s) => s.name === "__aenter__");
    expect(m).toBeDefined();
    expect(m!.kind).toBe("method");
    expect(m!.is_async).toBe(true);
  });

  it("extracts signature with return type for async functions", async () => {
    const symbols = await parsePython(`
async def get_user(id: int) -> dict:
    return {}
`);
    const fn = symbols.find((s) => s.name === "get_user");
    expect(fn).toBeDefined();
    expect(fn!.signature).toContain("(id: int)");
    expect(fn!.signature).toContain("-> dict");
  });
});

// --- Decorators ---

describe("extractPythonSymbols — decorator classification", () => {
  it("captures @property decorator", async () => {
    const symbols = await parsePython(`
class User:
    @property
    def name(self):
        return self._name
`);
    const m = symbols.find((s) => s.name === "name" && s.parent);
    expect(m).toBeDefined();
    expect(m!.decorators).toEqual(["@property"]);
    expect(m!.kind).toBe("method");
  });

  it("captures @classmethod decorator", async () => {
    const symbols = await parsePython(`
class User:
    @classmethod
    def from_dict(cls, d):
        return cls()
`);
    const m = symbols.find((s) => s.name === "from_dict");
    expect(m).toBeDefined();
    expect(m!.decorators).toEqual(["@classmethod"]);
  });

  it("captures @staticmethod decorator", async () => {
    const symbols = await parsePython(`
class User:
    @staticmethod
    def helper():
        return 1
`);
    const m = symbols.find((s) => s.name === "helper");
    expect(m).toBeDefined();
    expect(m!.decorators).toEqual(["@staticmethod"]);
  });

  it("tags @abstractmethod via meta.is_abstract", async () => {
    const symbols = await parsePython(`
class Base:
    @abstractmethod
    def run(self):
        pass
`);
    const m = symbols.find((s) => s.name === "run");
    expect(m).toBeDefined();
    expect(m!.decorators).toEqual(["@abstractmethod"]);
    expect(m!.meta).toBeDefined();
    expect(m!.meta!.is_abstract).toBe(true);
  });

  it("detects property setter via meta.property_accessor", async () => {
    const symbols = await parsePython(`
class User:
    @name.setter
    def name(self, value):
        self._name = value
`);
    const m = symbols.find((s) => s.name === "name" && s.decorators);
    expect(m).toBeDefined();
    expect(m!.meta).toBeDefined();
    expect(m!.meta!.property_accessor).toBe("setter");
  });

  it("detects property deleter", async () => {
    const symbols = await parsePython(`
class User:
    @name.deleter
    def name(self):
        del self._name
`);
    const m = symbols.find((s) => s.name === "name" && s.decorators);
    expect(m).toBeDefined();
    expect(m!.meta!.property_accessor).toBe("deleter");
  });

  it("captures @dataclass on classes", async () => {
    const symbols = await parsePython(`
@dataclass
class Point:
    x: int
`);
    const c = symbols.find((s) => s.name === "Point");
    expect(c).toBeDefined();
    expect(c!.decorators).toEqual(["@dataclass"]);
  });

  it("detects @dataclass(frozen=True) parameters", async () => {
    const symbols = await parsePython(`
@dataclass(frozen=True)
class Point:
    x: int
`);
    const c = symbols.find((s) => s.name === "Point");
    expect(c).toBeDefined();
    expect(c!.meta).toBeDefined();
    expect(c!.meta!.dataclass_frozen).toBe(true);
  });
});

// --- Superclasses ---

describe("extractPythonSymbols — superclasses", () => {
  it("extracts single superclass into extends", async () => {
    const symbols = await parsePython(`
class User(BaseModel):
    pass
`);
    const c = symbols.find((s) => s.name === "User");
    expect(c).toBeDefined();
    expect(c!.extends).toEqual(["BaseModel"]);
  });

  it("extracts multiple superclasses", async () => {
    const symbols = await parsePython(`
class Admin(User, Auditable):
    pass
`);
    const c = symbols.find((s) => s.name === "Admin");
    expect(c).toBeDefined();
    expect(c!.extends).toEqual(["User", "Auditable"]);
  });

  it("empty parent list produces no extends field", async () => {
    const symbols = await parsePython(`
class Empty:
    pass
`);
    const c = symbols.find((s) => s.name === "Empty");
    expect(c).toBeDefined();
    expect(c!.extends).toBeUndefined();
  });

  it("captures generic base types", async () => {
    const symbols = await parsePython(`
class Repo(Generic[T]):
    pass
`);
    const c = symbols.find((s) => s.name === "Repo");
    expect(c).toBeDefined();
    expect(c!.extends).toEqual(["Generic[T]"]);
  });

  it("skips metaclass keyword argument", async () => {
    const symbols = await parsePython(`
class Meta(Base, metaclass=ABCMeta):
    pass
`);
    const c = symbols.find((s) => s.name === "Meta");
    expect(c).toBeDefined();
    expect(c!.extends).toEqual(["Base"]);
  });
});

// --- Module constants and __all__ ---

describe("extractPythonSymbols — module constants and __all__", () => {
  it("extracts SCREAMING_CASE string constant", async () => {
    const symbols = await parsePython(`
API_URL = "https://example.com"
`);
    const c = symbols.find((s) => s.name === "API_URL");
    expect(c).toBeDefined();
    expect(c!.kind).toBe("constant");
    expect(c!.parent).toBeUndefined();
  });

  it("extracts annotated SCREAMING_CASE constant", async () => {
    const symbols = await parsePython(`
MAX_RETRIES: int = 3
`);
    const c = symbols.find((s) => s.name === "MAX_RETRIES");
    expect(c).toBeDefined();
    expect(c!.kind).toBe("constant");
  });

  it("does not extract module-level lowercase assignment", async () => {
    const symbols = await parsePython(`
logger = getLogger(__name__)
`);
    const c = symbols.find((s) => s.name === "logger");
    expect(c).toBeUndefined();
  });

  it("extracts __all__ as constant with list members in meta", async () => {
    const symbols = await parsePython(`
__all__ = ["Foo", "Bar"]
`);
    const c = symbols.find((s) => s.name === "__all__");
    expect(c).toBeDefined();
    expect(c!.kind).toBe("constant");
    expect(c!.meta).toBeDefined();
    expect(c!.meta!.all_members).toEqual(["Foo", "Bar"]);
  });

  it("extracts __all__ as tuple", async () => {
    const symbols = await parsePython(`
__all__ = ("X", "Y")
`);
    const c = symbols.find((s) => s.name === "__all__");
    expect(c).toBeDefined();
    expect(c!.meta!.all_members).toEqual(["X", "Y"]);
  });

  it("flags dynamic __all__ expressions", async () => {
    const symbols = await parsePython(`
__all__ = BASE + ["Extra"]
`);
    const c = symbols.find((s) => s.name === "__all__");
    expect(c).toBeDefined();
    expect(c!.meta!.all_computed).toBe(true);
  });

  it("does not extract class-level constants as module constants", async () => {
    const symbols = await parsePython(`
class Foo:
    INSIDE = 1
`);
    // Class-level INSIDE is fine to extract as field in Task 7, but must NOT
    // be a module-level constant (parent should be the class, not undefined).
    const moduleConstant = symbols.find(
      (s) => s.name === "INSIDE" && s.kind === "constant" && !s.parent,
    );
    expect(moduleConstant).toBeUndefined();
  });
});

// --- Dataclass fields, dunder tagging, nested walk ---

describe("extractPythonSymbols — dataclass fields and dunder methods", () => {
  it("extracts typed fields from dataclass body", async () => {
    const symbols = await parsePython(`
@dataclass
class Point:
    x: int
    y: int = 0
    label: str = "origin"
`);
    const cls = symbols.find((s) => s.name === "Point");
    expect(cls).toBeDefined();
    const fields = symbols.filter((s) => s.parent === cls!.id && s.kind === "field");
    const fieldNames = fields.map((f) => f.name).sort();
    expect(fieldNames).toEqual(["label", "x", "y"]);
  });

  it("tags __init__ as dunder via meta.is_dunder", async () => {
    const symbols = await parsePython(`
class Foo:
    def __init__(self):
        pass
`);
    const m = symbols.find((s) => s.name === "__init__");
    expect(m).toBeDefined();
    expect(m!.meta).toBeDefined();
    expect(m!.meta!.is_dunder).toBe(true);
  });

  it("tags __str__ and __repr__ as dunder", async () => {
    const symbols = await parsePython(`
class Foo:
    def __str__(self): return ""
    def __repr__(self): return ""
`);
    const str_ = symbols.find((s) => s.name === "__str__");
    const repr_ = symbols.find((s) => s.name === "__repr__");
    expect(str_!.meta!.is_dunder).toBe(true);
    expect(repr_!.meta!.is_dunder).toBe(true);
  });

  it("regular method does not get is_dunder", async () => {
    const symbols = await parsePython(`
class Foo:
    def save(self):
        pass
`);
    const m = symbols.find((s) => s.name === "save");
    expect(m).toBeDefined();
    expect(m!.meta?.is_dunder).toBeUndefined();
  });

  it("extracts nested class inside function", async () => {
    const symbols = await parsePython(`
def outer():
    class Inner:
        pass
`);
    const inner = symbols.find((s) => s.name === "Inner");
    expect(inner).toBeDefined();
    expect(inner!.kind).toBe("class");
  });

  it("extracts nested class inside class with proper parent", async () => {
    const symbols = await parsePython(`
class Outer:
    class Inner:
        pass
`);
    const outer = symbols.find((s) => s.name === "Outer");
    const inner = symbols.find((s) => s.name === "Inner");
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(inner!.parent).toBe(outer!.id);
  });
});

// --- Error resilience and depth cap ---

describe("extractPythonSymbols — error resilience", () => {
  it("does not throw on malformed Python source", async () => {
    const malformed = `
def foo(:
    this is not valid python
class Bar(
    def baz(
`;
    await expect(parsePython(malformed)).resolves.toBeDefined();
  });

  it("returns partial results from a file with a syntax error", async () => {
    // First function is valid; syntax error comes after
    const mixed = `
def valid_fn():
    return 1

def broken(:
    pass
`;
    const symbols = await parsePython(mixed);
    // Should at least extract the valid function
    const validFn = symbols.find((s) => s.name === "valid_fn");
    expect(validFn).toBeDefined();
  });

  it("handles deeply nested functions without crashing", async () => {
    // Build a 50-deep nested function structure
    let source = "";
    let indent = "";
    for (let i = 0; i < 50; i++) {
      source += `${indent}def f${i}():\n`;
      indent += "    ";
    }
    source += `${indent}pass\n`;
    await expect(parsePython(source)).resolves.toBeDefined();
    const symbols = await parsePython(source);
    // At minimum the outermost f0 should be present
    expect(symbols.find((s) => s.name === "f0")).toBeDefined();
  });
});

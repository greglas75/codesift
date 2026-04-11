import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { traceFastAPIDepends } from "../../src/tools/fastapi-depends.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);

function makeSym(o: Partial<CodeSymbol> & { name: string; file: string }): CodeSymbol {
  return {
    id: `test:${o.file}:${o.name}:${o.start_line ?? 1}`,
    repo: "test",
    kind: "function",
    start_line: 1,
    end_line: 10,
    ...o,
  };
}

function makeIndex(symbols: CodeSymbol[]): CodeIndex {
  return {
    repo: "test", root: "/tmp/test",
    symbols,
    files: [...new Set(symbols.map((s) => s.file))].map((f) => ({
      path: f, language: "python", symbol_count: 1, last_modified: Date.now(),
    })),
    created_at: Date.now(), updated_at: Date.now(),
    symbol_count: symbols.length, file_count: 1,
  };
}

describe("traceFastAPIDepends", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("finds endpoints with direct Depends()", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "get_db",
        file: "deps.py",
        source: "def get_db():\n    yield SessionLocal()",
      }),
      makeSym({
        name: "read_users",
        file: "routes.py",
        decorators: ["@app.get('/users')"],
        source: "@app.get('/users')\ndef read_users(db: Session = Depends(get_db)):\n    return db.query(User).all()",
      }),
    ]));

    const result = await traceFastAPIDepends("test");
    expect(result.total_endpoints).toBe(1);
    expect(result.endpoints[0]!.endpoint).toBe("read_users");
    expect(result.endpoints[0]!.depends).toHaveLength(1);
    expect(result.endpoints[0]!.depends[0]!.name).toBe("get_db");
    expect(result.endpoints[0]!.depends[0]!.is_yield).toBe(true);
    expect(result.endpoints[0]!.route).toBe("GET /users");
  });

  it("traces nested Depends() chains", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "get_settings",
        file: "deps.py",
        source: "def get_settings():\n    return Settings()",
      }),
      makeSym({
        name: "get_db",
        file: "deps.py",
        source: "def get_db(settings: Settings = Depends(get_settings)):\n    return Database(settings)",
      }),
      makeSym({
        name: "get_current_user",
        file: "deps.py",
        source: "def get_current_user(db: Database = Depends(get_db)):\n    return db.user()",
      }),
      makeSym({
        name: "read_me",
        file: "routes.py",
        decorators: ["@app.get('/me')"],
        source: "@app.get('/me')\ndef read_me(user: User = Depends(get_current_user)):\n    return user",
      }),
    ]));

    const result = await traceFastAPIDepends("test");
    const ep = result.endpoints[0]!;
    // Should trace: read_me → get_current_user → get_db → get_settings
    expect(ep.depends[0]!.name).toBe("get_current_user");
    expect(ep.depends[0]!.depends_on[0]!.name).toBe("get_db");
    expect(ep.depends[0]!.depends_on[0]!.depends_on[0]!.name).toBe("get_settings");
    expect(ep.all_deps).toEqual(["get_current_user", "get_db", "get_settings"]);
  });

  it("detects Security() deps and scopes", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "oauth2_scheme",
        file: "auth.py",
        source: "oauth2_scheme = OAuth2PasswordBearer(tokenUrl='/token')",
      }),
      makeSym({
        name: "admin_only",
        file: "routes.py",
        decorators: ["@app.get('/admin')"],
        source: "@app.get('/admin')\ndef admin_only(token: str = Security(oauth2_scheme, scopes=['admin', 'superuser'])):\n    return {}",
      }),
    ]));

    const result = await traceFastAPIDepends("test");
    const ep = result.endpoints[0]!;
    expect(ep.has_auth).toBe(true);
    expect(ep.depends[0]!.is_security).toBe(true);
    expect(ep.depends[0]!.scopes).toEqual(["admin", "superuser"]);
  });

  it("identifies endpoints_without_auth", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "public_info",
        file: "routes.py",
        decorators: ["@app.get('/info')"],
        source: "@app.get('/info')\ndef public_info():\n    return {}",
      }),
      makeSym({
        name: "oauth2_scheme",
        file: "auth.py",
        source: "x = 1",
      }),
      makeSym({
        name: "protected",
        file: "routes.py",
        decorators: ["@app.get('/protected')"],
        source: "@app.get('/protected')\ndef protected(token = Security(oauth2_scheme)):\n    return {}",
      }),
    ]));

    const result = await traceFastAPIDepends("test");
    expect(result.endpoints_without_auth).toHaveLength(1);
    expect(result.endpoints_without_auth[0]).toContain("/info");
  });

  it("reports shared_deps used by multiple endpoints", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({ name: "get_db", file: "deps.py", source: "def get_db(): yield x" }),
      makeSym({
        name: "list_a",
        file: "routes.py",
        decorators: ["@app.get('/a')"],
        source: "@app.get('/a')\ndef list_a(db = Depends(get_db)): pass",
      }),
      makeSym({
        name: "list_b",
        file: "routes.py",
        decorators: ["@app.get('/b')"],
        source: "@app.get('/b')\ndef list_b(db = Depends(get_db)): pass",
      }),
    ]));

    const result = await traceFastAPIDepends("test");
    expect(result.shared_deps).toHaveLength(1);
    expect(result.shared_deps[0]).toMatchObject({ name: "get_db", used_by: 2 });
  });

  it("handles circular dependency references without infinite loop", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "dep_a",
        file: "deps.py",
        source: "def dep_a(b = Depends(dep_b)): return b",
      }),
      makeSym({
        name: "dep_b",
        file: "deps.py",
        source: "def dep_b(a = Depends(dep_a)): return a",
      }),
      makeSym({
        name: "endpoint",
        file: "routes.py",
        decorators: ["@app.get('/')"],
        source: "@app.get('/')\ndef endpoint(x = Depends(dep_a)): return x",
      }),
    ]));

    // Should complete without throwing or hanging
    const result = await traceFastAPIDepends("test");
    expect(result.total_endpoints).toBe(1);
  });

  it("respects endpoint filter", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "one",
        file: "routes.py",
        decorators: ["@app.get('/1')"],
        source: "@app.get('/1')\ndef one(): pass",
      }),
      makeSym({
        name: "two",
        file: "routes.py",
        decorators: ["@app.get('/2')"],
        source: "@app.get('/2')\ndef two(): pass",
      }),
    ]));

    const result = await traceFastAPIDepends("test", { endpoint: "two" });
    expect(result.total_endpoints).toBe(1);
    expect(result.endpoints[0]!.endpoint).toBe("two");
  });

  it("ignores non-FastAPI functions (no route decorator)", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "helper",
        file: "utils.py",
        source: "def helper(db = Depends(get_db)): return db",
      }),
    ]));

    const result = await traceFastAPIDepends("test");
    expect(result.total_endpoints).toBe(0);
  });
});

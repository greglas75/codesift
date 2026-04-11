import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildHiltGraph, traceHiltGraph } from "../../src/tools/hilt-tools.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures — inline CodeSymbols mirroring what the Kotlin extractor produces
// ---------------------------------------------------------------------------

function makeSym(overrides: Partial<CodeSymbol> & { name: string; file: string }): CodeSymbol {
  return {
    id: `test:${overrides.file}:${overrides.name}:1`,
    repo: "test",
    kind: "class",
    start_line: 1,
    end_line: 10,
    ...overrides,
  };
}

function makeIndex(symbols: CodeSymbol[]): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    symbols,
    files: [],
    created_at: 0,
    updated_at: 0,
    symbol_count: symbols.length,
    file_count: 0,
  };
}

// Stub out getCodeIndex to return our fixture
vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildHiltGraph", () => {
  it("detects a @HiltViewModel with a matching @Provides method", async () => {
    const userViewModel = makeSym({
      name: "UserViewModel",
      file: "app/UserViewModel.kt",
      decorators: ["HiltViewModel"],
      source: `@HiltViewModel
class UserViewModel @Inject constructor(
    private val repo: UserRepository
) : ViewModel()`,
    });

    const repositoryModule = makeSym({
      name: "RepositoryModule",
      file: "app/di/RepositoryModule.kt",
      decorators: ["Module", "InstallIn"],
      source: `@Module
@InstallIn(SingletonComponent::class)
object RepositoryModule {
    @Provides
    fun provideUserRepo(): UserRepository {
        return UserRepositoryImpl()
    }
}`,
    });

    const provideMethod = makeSym({
      name: "provideUserRepo",
      file: "app/di/RepositoryModule.kt",
      kind: "method",
      parent: repositoryModule.id,
      decorators: ["Provides"],
      signature: "(): UserRepository",
      source: `@Provides
fun provideUserRepo(): UserRepository {
    return UserRepositoryImpl()
}`,
    });

    (getCodeIndex as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(
      makeIndex([userViewModel, repositoryModule, provideMethod]),
    );

    const graph = await buildHiltGraph("test");

    expect(graph.view_models).toHaveLength(1);
    expect(graph.view_models[0]!.name).toBe("UserViewModel");
    expect(graph.view_models[0]!.dependencies).toContain("UserRepository");

    expect(graph.modules).toHaveLength(1);
    expect(graph.modules[0]!.name).toBe("RepositoryModule");

    const edge = graph.edges.find(
      (e) => e.from === "UserViewModel" && e.to === "UserRepository",
    );
    expect(edge).toBeDefined();
    expect(edge!.provided_by).toBe("provideUserRepo");
    expect(edge!.module).toBe("RepositoryModule");
  });

  it("detects @AndroidEntryPoint classes", async () => {
    const mainActivity = makeSym({
      name: "MainActivity",
      file: "app/MainActivity.kt",
      decorators: ["AndroidEntryPoint"],
      source: `@AndroidEntryPoint
class MainActivity @Inject constructor(
    private val analytics: Analytics
) : AppCompatActivity()`,
    });

    (getCodeIndex as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(
      makeIndex([mainActivity]),
    );

    const graph = await buildHiltGraph("test");

    expect(graph.entry_points).toHaveLength(1);
    expect(graph.entry_points[0]!.name).toBe("MainActivity");
    expect(graph.entry_points[0]!.dependencies).toContain("Analytics");
  });

  it("records @Binds method providers (abstract return type mapping)", async () => {
    const bindingModule = makeSym({
      name: "BindingModule",
      file: "app/di/BindingModule.kt",
      decorators: ["Module", "InstallIn"],
      source: `@Module
@InstallIn(SingletonComponent::class)
abstract class BindingModule {
    @Binds
    abstract fun bindUserRepo(impl: UserRepositoryImpl): UserRepository
}`,
    });

    const bindMethod = makeSym({
      name: "bindUserRepo",
      file: "app/di/BindingModule.kt",
      kind: "method",
      parent: bindingModule.id,
      decorators: ["Binds"],
      signature: "(impl: UserRepositoryImpl): UserRepository",
      source: `@Binds
abstract fun bindUserRepo(impl: UserRepositoryImpl): UserRepository`,
    });

    (getCodeIndex as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(
      makeIndex([bindingModule, bindMethod]),
    );

    const graph = await buildHiltGraph("test");

    expect(graph.modules).toHaveLength(1);
    expect(graph.modules[0]!.providers).toHaveLength(1);
    expect(graph.modules[0]!.providers[0]!.kind).toBe("binds");
    expect(graph.modules[0]!.providers[0]!.provides).toBe("UserRepository");
  });

  it("does NOT crash on non-Hilt repos (returns empty graph)", async () => {
    const plainClass = makeSym({
      name: "User",
      file: "app/User.kt",
      source: `class User(val name: String)`,
    });

    (getCodeIndex as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(
      makeIndex([plainClass]),
    );

    const graph = await buildHiltGraph("test");
    expect(graph.view_models).toHaveLength(0);
    expect(graph.modules).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });
});

describe("traceHiltGraph", () => {
  it("returns dependency tree rooted at the requested class", async () => {
    const userViewModel = makeSym({
      name: "UserViewModel",
      file: "app/UserViewModel.kt",
      decorators: ["HiltViewModel"],
      source: `@HiltViewModel
class UserViewModel @Inject constructor(
    private val repo: UserRepository,
    private val logger: Logger
) : ViewModel()`,
    });

    const repositoryModule = makeSym({
      name: "RepositoryModule",
      file: "app/di/RepositoryModule.kt",
      decorators: ["Module"],
      source: `@Module
object RepositoryModule {
    @Provides fun provideUserRepo(): UserRepository = UserRepositoryImpl()
    @Provides fun provideLogger(): Logger = ConsoleLogger()
}`,
    });

    const provideRepo = makeSym({
      name: "provideUserRepo",
      file: "app/di/RepositoryModule.kt",
      kind: "method",
      parent: repositoryModule.id,
      decorators: ["Provides"],
      signature: "(): UserRepository",
      source: `@Provides fun provideUserRepo(): UserRepository = UserRepositoryImpl()`,
    });

    const provideLogger = makeSym({
      name: "provideLogger",
      file: "app/di/RepositoryModule.kt",
      kind: "method",
      parent: repositoryModule.id,
      decorators: ["Provides"],
      signature: "(): Logger",
      source: `@Provides fun provideLogger(): Logger = ConsoleLogger()`,
    });

    (getCodeIndex as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(
      makeIndex([userViewModel, repositoryModule, provideRepo, provideLogger]),
    );

    const tree = await traceHiltGraph("test", "UserViewModel");

    expect(tree.root.name).toBe("UserViewModel");
    expect(tree.root.kind).toBe("HiltViewModel");
    expect(tree.dependencies).toHaveLength(2);

    const repoDep = tree.dependencies.find((d) => d.name === "UserRepository");
    expect(repoDep).toBeDefined();
    expect(repoDep!.provided_by).toBe("provideUserRepo");
    expect(repoDep!.module).toBe("RepositoryModule");

    const loggerDep = tree.dependencies.find((d) => d.name === "Logger");
    expect(loggerDep).toBeDefined();
    expect(loggerDep!.provided_by).toBe("provideLogger");
  });

  it("throws when the requested class is not a Hilt entry point", async () => {
    const plainClass = makeSym({
      name: "PlainService",
      file: "app/PlainService.kt",
      source: `class PlainService`,
    });

    (getCodeIndex as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(
      makeIndex([plainClass]),
    );

    await expect(traceHiltGraph("test", "PlainService")).rejects.toThrow(/not a Hilt/i);
  });

  it("marks dependencies with missing providers as unresolved", async () => {
    const userViewModel = makeSym({
      name: "UserViewModel",
      file: "app/UserViewModel.kt",
      decorators: ["HiltViewModel"],
      source: `@HiltViewModel
class UserViewModel @Inject constructor(
    private val mystery: MysteryService
) : ViewModel()`,
    });

    (getCodeIndex as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(
      makeIndex([userViewModel]),
    );

    const tree = await traceHiltGraph("test", "UserViewModel");
    expect(tree.dependencies).toHaveLength(1);
    expect(tree.dependencies[0]!.name).toBe("MysteryService");
    expect(tree.dependencies[0]!.provided_by).toBeUndefined();
    expect(tree.dependencies[0]!.unresolved).toBe(true);
  });
});

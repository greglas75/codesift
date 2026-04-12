import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { searchSymbols } from "../../src/tools/search-tools.js";
import { resetConfigCache } from "../../src/config.js";

let tmpDir: string;
let fixtureDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-python-search-"));
  fixtureDir = join(tmpDir, "python-search-project");
  await mkdir(join(fixtureDir, "app"), { recursive: true });

  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function createPythonFixtureProject(): Promise<void> {
  await writeFile(
    join(fixtureDir, "app", "views.py"),
    `from dataclasses import dataclass

from django.contrib.auth.decorators import login_required


@login_required
def dashboard(request):
    return "ok"


@login_required()
def settings_view(request):
    return "ok"


@dataclass
class Account:
    id: int
    email: str
`,
  );

  await writeFile(
    join(fixtureDir, "app", "api.py"),
    `from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
def healthcheck():
    return {"ok": True}
`,
  );
}

describe("search_symbols decorator filtering", () => {
  it("matches bare decorator names for Python symbols", async () => {
    await createPythonFixtureProject();
    const repo = (await indexFolder(fixtureDir, { watch: false })).repo;

    const results = await searchSymbols(repo, "", {
      decorator: "login_required",
      top_k: 10,
    });

    expect(results.map((r) => r.symbol.name)).toEqual(["dashboard", "settings_view"]);
    for (const result of results) {
      expect(result.symbol.decorators?.some((decorator) => decorator.startsWith("@login_required"))).toBe(true);
    }
  });

  it("matches decorator metadata with leading @ and kind filters", async () => {
    await createPythonFixtureProject();
    const repo = (await indexFolder(fixtureDir, { watch: false })).repo;

    const results = await searchSymbols(repo, "", {
      decorator: "@dataclass",
      kind: "class",
      top_k: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.symbol.name).toBe("Account");
    expect(results[0]!.symbol.decorators).toContain("@dataclass");
  });

  it("matches decorator calls with arguments using bare filter names", async () => {
    await createPythonFixtureProject();
    const repo = (await indexFolder(fixtureDir, { watch: false })).repo;

    const results = await searchSymbols(repo, "health", {
      decorator: "router.get",
      top_k: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.symbol.name).toBe("healthcheck");
    expect(results[0]!.symbol.decorators).toContain("@router.get(\"/health\")");
  });

  it("returns no results when no symbol has the requested decorator", async () => {
    await createPythonFixtureProject();
    const repo = (await indexFolder(fixtureDir, { watch: false })).repo;

    const results = await searchSymbols(repo, "", {
      decorator: "staff_member_required",
      top_k: 10,
    });

    expect(results).toEqual([]);
  });
});

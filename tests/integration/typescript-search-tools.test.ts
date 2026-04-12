import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { searchSymbols } from "../../src/tools/search-tools.js";
import { resetConfigCache } from "../../src/config.js";

let tmpDir: string;
let fixtureDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-ts-search-"));
  fixtureDir = join(tmpDir, "typescript-search-project");
  await mkdir(join(fixtureDir, "src"), { recursive: true });

  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function createTypeScriptFixtureProject(): Promise<void> {
  await writeFile(
    join(fixtureDir, "src", "users.controller.ts"),
    `@Controller('users')
export class UsersController {
  @Get(':id')
  @UseGuards(AuthGuard)
  findOne() {
    return null;
  }

  @Public()
  @Get('health')
  health() {
    return 'ok';
  }
}
`,
  );
}

describe("search_symbols decorator filtering — TypeScript", () => {
  it("matches Nest class decorators", async () => {
    await createTypeScriptFixtureProject();
    const repo = (await indexFolder(fixtureDir, { watch: false })).repo;

    const results = await searchSymbols(repo, "", {
      decorator: "Controller",
      top_k: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.symbol.name).toBe("UsersController");
    expect(results[0]!.symbol.decorators).toContain("@Controller('users')");
  });

  it("matches method decorators with arguments", async () => {
    await createTypeScriptFixtureProject();
    const repo = (await indexFolder(fixtureDir, { watch: false })).repo;

    const results = await searchSymbols(repo, "", {
      decorator: "UseGuards",
      top_k: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.symbol.name).toBe("findOne");
    expect(results[0]!.symbol.decorators).toEqual(["@Get(':id')", "@UseGuards(AuthGuard)"]);
  });

  it("matches custom bare decorators on methods", async () => {
    await createTypeScriptFixtureProject();
    const repo = (await indexFolder(fixtureDir, { watch: false })).repo;

    const results = await searchSymbols(repo, "", {
      decorator: "Public",
      top_k: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.symbol.name).toBe("health");
    expect(results[0]!.symbol.decorators).toContain("@Public()");
  });
});

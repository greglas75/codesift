import { describe, it, expect } from "vitest";
import { generateReport } from "../../src/tools/report-tools.js";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";

let tmpDir: string;

async function createIndexedFixture(files: Record<string, string>): Promise<{ repo: string; root: string }> {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-report-react-"));
  const projDir = join(tmpDir, "test-react-project");
  await mkdir(projDir, { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
  for (const [rel, content] of Object.entries(files)) {
    const full = join(projDir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  await indexFolder(projDir, { watch: false });
  return { repo: "local/test-react-project", root: projDir };
}

async function cleanup() {
  if (tmpDir) {
    delete process.env["CODESIFT_DATA_DIR"];
    resetConfigCache();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    tmpDir = "";
  }
}

describe("generate_report React section (Item 13)", () => {
  it("includes React section when component symbols exist", async () => {
    const { repo, root } = await createIndexedFixture({
      "src/Button.tsx": `function Button() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}`,
      "src/App.tsx": `function App() {
  const auth = useAuth();
  return <Button/>;
}`,
    });
    try {
      const result = await generateReport(repo);
      const html = await readFile(result.path, "utf-8");
      expect(html).toContain("<h2>React</h2>");
      expect(html).toContain("components");
      expect(html).toContain("Button");
    } finally {
      await cleanup();
    }
  });

  it("does NOT include React section for non-React project", async () => {
    const { repo } = await createIndexedFixture({
      "src/index.ts": "export const x = 42;",
      "src/util.ts": "export function helper() { return 1; }",
    });
    try {
      const result = await generateReport(repo);
      const html = await readFile(result.path, "utf-8");
      expect(html).not.toContain("<h2>React</h2>");
    } finally {
      await cleanup();
    }
  });
});

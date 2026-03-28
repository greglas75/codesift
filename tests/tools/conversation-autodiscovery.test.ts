import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("auto-discovery", () => {
  it("encodeCwdToClaudePath converts / to -", async () => {
    const { encodeCwdToClaudePath } = await import("../../src/tools/conversation-tools.js");
    const result = encodeCwdToClaudePath("/Users/dev/my-project");
    expect(result).toBe("-Users-dev-my-project");
  });

  it("encodeCwdToClaudePath handles spaces", async () => {
    const { encodeCwdToClaudePath } = await import("../../src/tools/conversation-tools.js");
    const result = encodeCwdToClaudePath("/Users/dev/my project");
    expect(result).toBe("-Users-dev-my project");
  });
});

describe("hook installation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hook-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates .claude/settings.local.json with correct hook format", async () => {
    const { installSessionEndHook } = await import("../../src/tools/conversation-tools.js");
    await installSessionEndHook(tmpDir);

    const settingsPath = join(tmpDir, ".claude", "settings.local.json");
    const content = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(content.hooks.Stop).toBeDefined();
    expect(content.hooks.Stop[0].hooks[0].type).toBe("command");
    expect(content.hooks.Stop[0].hooks[0].command).toContain("codesift");
  });

  it("does not duplicate hook on second call (idempotent)", async () => {
    const { installSessionEndHook } = await import("../../src/tools/conversation-tools.js");
    await installSessionEndHook(tmpDir);
    await installSessionEndHook(tmpDir);

    const settingsPath = join(tmpDir, ".claude", "settings.local.json");
    const content = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(content.hooks.Stop).toHaveLength(1);
  });

  it("preserves existing hooks when adding", async () => {
    const { installSessionEndHook } = await import("../../src/tools/conversation-tools.js");
    const settingsDir = join(tmpDir, ".claude");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.local.json"), JSON.stringify({
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo done" }] }] }
    }));

    await installSessionEndHook(tmpDir);

    const content = JSON.parse(await readFile(join(settingsDir, "settings.local.json"), "utf-8"));
    expect(content.hooks.Stop).toHaveLength(2);
    expect(content.hooks.Stop[0].hooks[0].command).toBe("echo done");
  });
});

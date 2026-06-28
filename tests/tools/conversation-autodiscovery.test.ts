import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

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
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("does not create a session-end hook", async () => {
    const { installSessionEndHook } = await import("../../src/tools/conversation-tools.js");
    await installSessionEndHook(tmpDir);

    const settingsPath = join(tmpDir, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("is idempotent", async () => {
    const { installSessionEndHook } = await import("../../src/tools/conversation-tools.js");
    await installSessionEndHook(tmpDir);
    await installSessionEndHook(tmpDir);

    const settingsPath = join(tmpDir, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("preserves existing files by not touching them", async () => {
    const { installSessionEndHook } = await import("../../src/tools/conversation-tools.js");
    const settingsDir = join(tmpDir, ".claude");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.local.json"), JSON.stringify({
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo done" }] }] }
    }));

    await installSessionEndHook(tmpDir);

    const content = JSON.parse(await readFile(join(settingsDir, "settings.local.json"), "utf-8"));
    expect(content.hooks.Stop).toHaveLength(1);
    expect(content.hooks.Stop[0].hooks[0].command).toBe("echo done");
  });
});

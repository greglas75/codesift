import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectStack } from "../../src/tools/project-profile-stack.js";

/**
 * B-13 — the real version of a test Biome exposed as theatre.
 *
 * The old one was called "detects Yii2 from composer.json yiisoft/yii2 dependency", imported
 * `detectStack`, never called it, and asserted that a source file contained the string
 * `"laravel", "symfony", "yii2"`. Grepping a literal proves the list exists; it proves nothing
 * about what happens when a real composer.json is read. These call the function.
 */

let dir: string;

async function composer(require: Record<string, string>, extra?: Record<string, unknown>) {
  await writeFile(join(dir, "composer.json"), JSON.stringify({ require, ...extra }), "utf-8");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-detectstack-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("detectStack — PHP frameworks from composer.json", () => {
  it("detects yii2 and cites the dependency it read it from", async () => {
    await composer({ "yiisoft/yii2": "^2.0.45", php: ">=8.1" });
    const stack = await detectStack(dir);
    expect(stack.framework).toBe("yii2");
    expect(stack.framework_version).toBe("2.0.45");
    // The evidence trail matters as much as the verdict: a profile that says "yii2" without
    // saying where it got that is not checkable.
    expect(stack.detected_from).toContain("composer.json:require.yiisoft/yii2");
  });

  it("detects laravel, and prefers it over yii2 when both are present", async () => {
    await composer({ "laravel/framework": "^11.0", "yiisoft/yii2": "^2.0" });
    const stack = await detectStack(dir);
    expect(stack.framework).toBe("laravel");
    expect(stack.framework_version).toBe("11.0");
  });

  it("detects symfony via framework-bundle", async () => {
    await composer({ "symfony/framework-bundle": "^7.0" });
    expect((await detectStack(dir)).framework).toBe("symfony");
  });

  it("reads require-dev too, not only require", async () => {
    await composer({ php: ">=8.1" }, { "require-dev": { "yiisoft/yii2": "^2.0.49" } });
    expect((await detectStack(dir)).framework).toBe("yii2");
  });

  it("reports no framework for a composer.json with none of them", async () => {
    // The honest negative: absence must not be reported as one of the three.
    await composer({ php: ">=8.1", "monolog/monolog": "^3.0" });
    const stack = await detectStack(dir);
    expect(stack.framework).toBeNull();
    expect(stack.detected_from.join(" ")).not.toMatch(/laravel|yii2|symfony/);
  });

  it("does not invent a framework when there is no composer.json at all", async () => {
    expect((await detectStack(dir)).framework).toBeNull();
  });
});

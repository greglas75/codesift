import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Converted tools read through the narrow accessors (ADR-004 stage 2); the helper derives them all
// from this one getCodeIndex stub so the fixture cannot drift between shapes.
vi.mock("../../src/tools/index-tools.js", async () => {
  const { narrowIndexMock } = await import("../helpers/narrow-index-mock.js");
  return narrowIndexMock(vi.fn());
});

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { resolvePhpNamespace } from "../../src/tools/php-tools.js";

describe("resolvePhpNamespace", () => {
  it("keeps production autoload roots before autoload-dev roots for the same prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesift-php-psr4-"));
    try {
      await writeFile(
        join(root, "composer.json"),
        JSON.stringify({
          autoload: { "psr-4": { "app\\": "./" } },
          "autoload-dev": { "psr-4": { "app\\": "tests/" } },
        }),
      );
      vi.mocked(getCodeIndex).mockResolvedValue({
        repo: "test",
        root,
        symbols: [],
        files: [
          { path: "components/Mailer.php", language: "php", symbol_count: 0, last_modified: 0 },
          { path: "tests/components/Mailer.php", language: "php", symbol_count: 0, last_modified: 0 },
        ],
        created_at: 0,
        updated_at: 0,
        symbol_count: 0,
        file_count: 2,
      });

      const resolved = await resolvePhpNamespace("test", "app\\components\\Mailer");

      expect(resolved.exists).toBe(true);
      expect(resolved.file_path).toBe("./components/Mailer.php");
      expect(resolved.psr4_root).toBe("./");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

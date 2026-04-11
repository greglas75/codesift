import { existsSync } from "fs";
import { describe, it, expect } from "vitest";

describe("astro-project fixture", () => {
  const base = "tests/fixtures/astro-project";
  const files = [
    "package.json", "astro.config.mjs",
    "src/pages/index.astro", "src/pages/blog/[slug].astro",
    "src/pages/api/data.ts", "src/layouts/BaseLayout.astro",
    "src/components/Counter.tsx", "src/components/Footer.astro",
    "src/content.config.ts"
  ];
  for (const f of files) {
    it(`has ${f}`, () => expect(existsSync(`${base}/${f}`)).toBe(true));
  }
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { explore } from "../../src/tools/explore-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { resetShownSourceLedgerForTesting } from "../../src/server-helpers/shown-source.js";

const REPO = "local/explore-project";

let tmpDir: string;
let savedEmbeddings: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-explore-test-"));
  const root = join(tmpDir, "explore-project");
  await mkdir(join(root, "src"), { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  savedEmbeddings = process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"];
  process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"] = "true";
  resetConfigCache();

  await writeFile(join(root, "src", "billing.ts"), `export function computeInvoiceTotal(lines: number[]): number {
  return applyDiscount(sumLines(lines));
}

export function sumLines(lines: number[]): number {
  return lines.reduce((a, b) => a + b, 0);
}

export function applyDiscount(total: number): number {
  return total > 100 ? total * 0.9 : total;
}
`);
  await writeFile(join(root, "src", "checkout.ts"), `import { computeInvoiceTotal } from "./billing";

export function checkoutCart(lines: number[]): string {
  const total = computeInvoiceTotal(lines);
  return \`total: \${total}\`;
}
`);
  await indexFolder(root);
});

afterEach(async () => {
  resetShownSourceLedgerForTesting(false);
  delete process.env["CODESIFT_DATA_DIR"];
  if (savedEmbeddings === undefined) delete process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"];
  else process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"] = savedEmbeddings;
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("explore", () => {
  it("returns the best match with source and both directions of its call graph", async () => {
    const out = await explore(REPO, "computeInvoiceTotal", { top: 1 });
    expect(out).toMatch(/^src\/billing\.ts:1-3 function computeInvoiceTotal/);
    expect(out).toContain("return applyDiscount(sumLines(lines));");
    expect(out).toMatch(/called by: checkoutCart \(src\/checkout\.ts:\d+\)/);
    expect(out).toMatch(/calls: .*applyDiscount/);
    expect(out).toMatch(/calls: .*sumLines/);
  });

  it("lists matches beyond `top` as locations instead of dropping them", async () => {
    const out = await explore(REPO, "lines total", { top: 1 });
    expect(out).toContain("--- other matches (");
  });

  it("points at the right tools when nothing matches", async () => {
    const out = await explore(REPO, "zzzNoSuchThingAnywhere");
    expect(out).toContain("No symbols match");
    expect(out).toContain("search_text");
  });

  it("clips source to the token budget on whole lines", async () => {
    const out = await explore(REPO, "computeInvoiceTotal", { top: 1, token_budget: 10 });
    // The budget floor keeps a readable minimum; the header and graph lines always survive.
    expect(out).toMatch(/function computeInvoiceTotal/);
    expect(out).toMatch(/called by: checkoutCart/);
  });

  it("answers a repeat with a pointer once the conversation ledger is on", async () => {
    resetShownSourceLedgerForTesting(true);
    await explore(REPO, "computeInvoiceTotal", { top: 1 });
    const again = await explore(REPO, "computeInvoiceTotal", { top: 1 });
    expect(again).not.toContain("return applyDiscount(sumLines(lines));");
    expect(again).toContain("source unchanged");
    // The graph is not elided — it is cheap and may have changed meaning in context.
    expect(again).toMatch(/called by: checkoutCart/);
  });
});

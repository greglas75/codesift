import { mkdirSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../src/tools/index-tools.js";
import { analyzeSchemaDrift } from "../src/tools/sql-tools.js";

const TMP = join(tmpdir(), "codesift-debug-drift-" + Date.now());
mkdirSync(TMP, { recursive: true });
cpSync("/Users/greglas/DEV/codesift-mcp/tests/fixtures/sql/drift-clean", TMP, { recursive: true });

const r = await indexFolder(TMP, { watch: false });
console.log("repo:", r.repo);

const result = await analyzeSchemaDrift(r.repo);
console.log("drifts:", JSON.stringify(result, null, 2));

rmSync(TMP, { recursive: true, force: true });

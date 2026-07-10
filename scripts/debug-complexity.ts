import { indexFolder } from "../src/tools/index-tools.js";
import { analyzeSchemaComplexity } from "../src/tools/sql-tools.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const TMP = "/tmp/debug-complexity";
try { rmSync(TMP, { recursive: true }); } catch { /* ignore */ }
mkdirSync(TMP);

// Exactly the same content as the failing test fixture
const sql = [
  "CREATE TABLE god_table (",
  "  id INT PRIMARY KEY,",
  "  c1 TEXT,",
  "  c2 TEXT,",
  "  c3 TEXT,",
  "  c4 TEXT,",
  "  c5 TEXT,",
  "  c6 TEXT,",
  "  c7 TEXT,",
  "  c8 TEXT,",
  "  c9 TEXT,",
  "  c10 TEXT,",
  "  c11 TEXT,",
  "  c12 TEXT,",
  "  c13 TEXT,",
  "  c14 TEXT,",
  "  c15 TEXT,",
  "  c16 TEXT,",
  "  c17 TEXT,",
  "  c18 TEXT,",
  "  c19 TEXT,",
  "  c20 TEXT,",
  "  c21 TEXT",
  ");",
].join("\n");

writeFileSync(TMP + "/schema.sql", sql);

const r = await indexFolder(TMP, { watch: false });
const res = await analyzeSchemaComplexity(r.repo);
console.log(JSON.stringify(res.tables, null, 2));

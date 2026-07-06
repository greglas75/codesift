/** SQL migration diff classification capability. */

import { getCodeIndex } from "./index-tools.js";

export interface MigrationOp {
  operation: string;         // e.g. "CREATE TABLE", "DROP COLUMN", "ALTER TABLE ADD"
  target: string;            // e.g. "users", "users.name"
  severity: "low" | "medium" | "high";
  file: string;
  line: number;
  raw: string;               // trimmed source line
}

export interface DiffMigrationsResult {
  additive: MigrationOp[];      // CREATE TABLE, ADD COLUMN, CREATE INDEX
  modifying: MigrationOp[];     // ALTER TABLE ADD, ALTER COLUMN
  destructive: MigrationOp[];   // DROP TABLE, DROP COLUMN, DROP INDEX
  summary: {
    additive: number;
    modifying: number;
    destructive: number;
    total_files: number;
  };
}

const MIGRATION_PATTERNS: Array<{
  regex: RegExp;
  operation: string;
  category: "additive" | "modifying" | "destructive";
  severity: "low" | "medium" | "high";
  /** Capture group index for the target name */
  targetGroup: number;
}> = [
  // Destructive (high severity)
  { regex: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i, operation: "DROP TABLE", category: "destructive", severity: "high", targetGroup: 1 },
  { regex: /ALTER\s+TABLE\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i, operation: "DROP COLUMN", category: "destructive", severity: "high", targetGroup: 1 },
  { regex: /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i, operation: "DROP INDEX", category: "destructive", severity: "medium", targetGroup: 1 },
  { regex: /ALTER\s+TABLE\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s+DROP\s+CONSTRAINT/i, operation: "DROP CONSTRAINT", category: "destructive", severity: "medium", targetGroup: 1 },
  { regex: /TRUNCATE\s+(?:TABLE\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i, operation: "TRUNCATE", category: "destructive", severity: "high", targetGroup: 1 },

  // Modifying (medium severity)
  { regex: /ALTER\s+TABLE\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s+ADD\s+COLUMN/i, operation: "ADD COLUMN", category: "modifying", severity: "low", targetGroup: 1 },
  { regex: /ALTER\s+TABLE\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s+ADD\s+(?!COLUMN)/i, operation: "ALTER TABLE ADD", category: "modifying", severity: "low", targetGroup: 1 },
  { regex: /ALTER\s+TABLE\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s+ALTER\s+COLUMN/i, operation: "ALTER COLUMN", category: "modifying", severity: "medium", targetGroup: 1 },
  { regex: /ALTER\s+TABLE\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s+RENAME/i, operation: "RENAME", category: "modifying", severity: "medium", targetGroup: 1 },

  // Additive (low severity) — these overlap with the extractor's DDL patterns
  { regex: /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i, operation: "CREATE TABLE", category: "additive", severity: "low", targetGroup: 1 },
  { regex: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i, operation: "CREATE INDEX", category: "additive", severity: "low", targetGroup: 1 },
  { regex: /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i, operation: "CREATE VIEW", category: "additive", severity: "low", targetGroup: 1 },
];

function pickTarget(m: RegExpExecArray, startGroup: number): string {
  for (let i = startGroup; i < m.length; i++) {
    if (m[i]) return m[i]!;
  }
  return "(unknown)";
}

export async function diffMigrations(
  repo: string,
  options?: { file_pattern?: string },
): Promise<DiffMigrationsResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const filePattern = options?.file_pattern;

  // Find .sql files, sorted by name (migration order heuristic)
  const sqlFiles = index.files
    .filter((f) => (f.language === "sql" || f.language === "sql-jinja"))
    .filter((f) => !filePattern || f.path.includes(filePattern))
    .sort((a, b) => a.path.localeCompare(b.path));

  const additive: MigrationOp[] = [];
  const modifying: MigrationOp[] = [];
  const destructive: MigrationOp[] = [];

  for (const fileEntry of sqlFiles) {
    // Read file source from symbols (each symbol has source)
    // Or reconstruct from all symbols in this file
    const fileSymbols = index.symbols.filter((s) => s.file === fileEntry.path);

    // Collect all raw source lines we can access
    const seenLines = new Set<string>();
    for (const sym of fileSymbols) {
      if (!sym.source) continue;
      for (const line of sym.source.split("\n")) {
        seenLines.add(line);
      }
    }

    // Also scan the file directly for DML patterns not captured as symbols
    // (ALTER, DROP, TRUNCATE aren't symbols — they're imperative ops)
    let fullSource: string | undefined;
    try {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      fullSource = readFileSync(join(index.root, fileEntry.path), "utf-8");
    } catch {
      // File not accessible — use symbol sources only
    }

    const linesToScan = fullSource
      ? fullSource.split("\n")
      : [...seenLines];

    for (let lineIdx = 0; lineIdx < linesToScan.length; lineIdx++) {
      const line = linesToScan[lineIdx]!;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("--")) continue;

      for (const pat of MIGRATION_PATTERNS) {
        const m = pat.regex.exec(trimmed);
        if (!m) continue;

        const target = pickTarget(m, pat.targetGroup);

        // For DROP COLUMN, include table.column
        let fullTarget = target;
        if (pat.operation === "DROP COLUMN") {
          const colName = pickTarget(m, 5); // groups 5-8 are the column name
          fullTarget = `${target}.${colName}`;
        }

        const op: MigrationOp = {
          operation: pat.operation,
          target: fullTarget,
          severity: pat.severity,
          file: fileEntry.path,
          line: lineIdx + 1,
          raw: trimmed.slice(0, 120),
        };

        switch (pat.category) {
          case "additive": additive.push(op); break;
          case "modifying": modifying.push(op); break;
          case "destructive": destructive.push(op); break;
        }
        break; // first match wins per line
      }
    }
  }

  return {
    additive,
    modifying,
    destructive,
    summary: {
      additive: additive.length,
      modifying: modifying.length,
      destructive: destructive.length,
      total_files: sqlFiles.length,
    },
  };
}

// ── find_orphan_tables ────────────────────────────────────

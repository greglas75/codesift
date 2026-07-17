import type { BuiltinPatternDefinition } from "../types.js";

export const DATABASE_PATTERNS: Record<string, BuiltinPatternDefinition> = {
  // --- Database / ORM anti-patterns (db-audit feedback) ---
  "unsafe-raw-sql": {
    regex: /(?:\$queryRawUnsafe|\$executeRawUnsafe|knex\.raw|sequelize\.query|db\.raw)\s*\(\s*[`"'][^`"']*\$\{/,
    description: "Raw SQL with template-string interpolation — SQL injection risk. Use parameterized $queryRaw`...` or query builder. Covers Prisma/Knex/Sequelize/Drizzle.",
  },
  "transaction-external-io": {
    regex: /\$transaction\s*\(\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,2000}?\b(?:fetch|axios|http|stripe|sendgrid|twilio|sendEmail|publishEvent|enqueue)\s*[.(]/,
    description: "External I/O (fetch/HTTP/email/queue) inside Prisma $transaction callback — long-running transactions hold locks. Move I/O after commit.",
  },
  "migration-create-index-no-concurrently": {
    regex: /CREATE\s+(?:UNIQUE\s+)?INDEX(?!\s+CONCURRENTLY)/i,
    description: "CREATE INDEX without CONCURRENTLY — locks the table during build. Use CREATE INDEX CONCURRENTLY in PostgreSQL migrations.",
    fileIncludePattern: /\/migrations?\/.*\.sql$/,
  },
  "migration-drop-column": {
    regex: /\bALTER\s+TABLE[\s\S]{0,200}\bDROP\s+COLUMN\b/i,
    description: "DROP COLUMN in migration — destructive, breaks rolling deploys. Use multi-step deprecation: stop writes → backfill → drop in next release.",
    fileIncludePattern: /\/migrations?\/.*\.sql$/,
  },
  "migration-alter-column-type": {
    regex: /\bALTER\s+TABLE[\s\S]{0,200}\bALTER\s+COLUMN[\s\S]{0,200}\bTYPE\b/i,
    description: "ALTER COLUMN TYPE in migration — full table rewrite, locks table. Use ADD COLUMN + backfill + DROP COLUMN in separate releases.",
    fileIncludePattern: /\/migrations?\/.*\.sql$/,
  },
  "migration-not-null-no-default": {
    regex: /\bADD\s+COLUMN\b[\s\S]{0,200}\bNOT\s+NULL\b(?![\s\S]{0,100}\bDEFAULT\b)/i,
    description: "ADD COLUMN NOT NULL without DEFAULT — fails on existing rows. Add as nullable first, backfill, then add NOT NULL constraint.",
    fileIncludePattern: /\/migrations?\/.*\.sql$/,
  },
};

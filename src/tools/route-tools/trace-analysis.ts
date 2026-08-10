import type { CodeSymbol } from "../../types.js";
import type { DbCall } from "./types.js";

const DB_PATTERNS = [
  /prisma\.\w+\.(findMany|findFirst|findUnique|create|update|delete|upsert|count|aggregate|groupBy)/,
  /\.\$(transaction|queryRaw|executeRaw)/,
  /getRepository|\.query\(|\.execute\(/,
  /knex\.|\.raw\(/,
  /->find\(\)|->findOne\(|->findAll\(|->findBySql\(/,
  /->createCommand\(|Yii::\$app->db/,
  /::find\(\)->where\(|->andWhere\(|->orWhere\(/,
  /transaction\s*\{[\s\S]*?\.(select|insert|update|delete)/,
  /\.(findById|findAll|save|deleteById|findBy\w+)\s*\(/,
  /\bSchemaUtils\.(create|drop)/,
  /\.objects\.(get|filter|all|exclude|create|update|delete|aggregate|annotate|values|values_list|count|exists|first|last|bulk_create|bulk_update|get_or_create|update_or_create)\s*\(/,
  /\.query\.(filter|filter_by|get|all|first|one|one_or_none|join|outerjoin|subquery)\s*\(/,
  /session\.(add|delete|commit|rollback|flush|execute|query)\s*\(/,
  /\.select_related\(|\.prefetch_related\(/,
];

export function findDbCalls(symbols: CodeSymbol[]): DbCall[] {
  const calls: DbCall[] = [];
  for (const symbol of symbols) {
    const source = symbol.source;
    if (!source) continue;
    const match = DB_PATTERNS
      .map((pattern) => pattern.exec(source))
      .find((candidate) => candidate !== null);
    if (!match) continue;
    calls.push({
      symbol_name: symbol.name,
      file: symbol.file,
      line: symbol.start_line,
      operation: match[0],
    });
  }
  return calls;
}

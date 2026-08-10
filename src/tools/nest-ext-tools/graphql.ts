import { readNestSource, requireNestCodeIndex } from "./shared.js";
import type { NestToolError } from "../nest-tools.js";

// ---------------------------------------------------------------------------
// G5: nest_graphql_map — GraphQL resolver discovery
// ---------------------------------------------------------------------------

export interface NestGraphQLEntry {
  resolver_class: string;
  file: string;
  operation: "Query" | "Mutation" | "Subscription" | "ResolveField";
  handler: string;
  return_type?: string;
}

export interface NestGraphQLMapResult {
  entries: NestGraphQLEntry[];
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestGraphQLMap(
  repo: string,
  options?: { max_entries?: number },
): Promise<NestGraphQLMapResult> {
  const index = await requireNestCodeIndex(repo);

  const maxEntries = options?.max_entries ?? 300;
  const entries: NestGraphQLEntry[] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  const resolverFiles = index.files.filter(
    (f) => f.path.endsWith(".resolver.ts") || f.path.endsWith(".resolver.js"),
  );

  for (const file of resolverFiles) {
    if (entries.length >= maxEntries) { truncated = true; break; }
    const source = await readNestSource(index, file.path, errors);
    if (source === undefined) continue;

    // Find resolver class name (searches for class declaration near @Resolver decorator)
    const resolverClassMatch = /@Resolver\s*\([\s\S]*?\)\s*(?:export\s+)?class\s+(\w+)/.exec(source);
    const resolverClass = resolverClassMatch?.[1] ?? "UnknownResolver";

    // Extract GraphQL operation decorators with their handler names
    // R-2 fix: cap decorator args to 300 chars to prevent cross-method boundary matching
    const opRe = /@(Query|Mutation|Subscription|ResolveField)\s*\(([\s\S]{0,300}?)\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = opRe.exec(source)) !== null) {
      if (entries.length >= maxEntries) { truncated = true; break; }
      const operation = m[1]! as NestGraphQLEntry["operation"];
      const args = m[2]!;
      const handler = m[3]!;

      // Extract return type from decorator arg: () => Article → Article
      const returnTypeMatch = /\(\s*\)\s*=>\s*(?:\[\s*)?(\w+)/.exec(args);
      const entry: NestGraphQLEntry = {
        resolver_class: resolverClass,
        file: file.path,
        operation,
        handler,
      };
      if (returnTypeMatch) entry.return_type = returnTypeMatch[1]!;
      entries.push(entry);
    }
  }

  return {
    entries,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

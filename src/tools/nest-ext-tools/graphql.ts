import {
  findClassAtPosition,
  findDecoratedClass,
  findDecoratorCalls,
  findNestClassRanges,
  findNestMethodAfter,
  readNestSource,
  requireNestCodeIndex,
} from "./shared.js";
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

    const classRanges = findNestClassRanges(source);
    const resolverClasses = new Set(
      findDecoratorCalls(source, "Resolver")
        .map((call) => findDecoratedClass(classRanges, call)?.start)
        .filter((start): start is number => start !== undefined),
    );

    const calls = (["Query", "Mutation", "Subscription", "ResolveField"] as const)
      .flatMap((operation) =>
        findDecoratorCalls(source, operation).map((call) => ({ ...call, operation })),
      )
      .sort((left, right) => left.start - right.start);
    for (const call of calls) {
      const owner = findClassAtPosition(classRanges, call.start);
      if (!owner || !resolverClasses.has(owner.start)) continue;
      if (entries.length >= maxEntries) { truncated = true; break; }
      const method = findNestMethodAfter(source, call.end);
      if (!method || method.start >= owner.end) continue;

      // Extract return type from decorator arg: () => Article → Article
      const returnTypeMatch = /\(\s*\)\s*=>\s*(?:\[\s*)?(\w+)/.exec(call.args);
      const entry: NestGraphQLEntry = {
        resolver_class: owner.name,
        file: file.path,
        operation: call.operation,
        handler: method.name,
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

import {
  findClassAtPosition,
  findDecoratorCalls,
  findNestClassRanges,
  firstNestDecoratorArgument,
  readNestSource,
  requireNestCodeIndex,
  stripLeadingNestComments,
} from "./shared.js";
import type { NestToolError } from "../nest-tools.js";

// ---------------------------------------------------------------------------
// G14: nest_microservice_map — @MessagePattern / @EventPattern discovery
// ---------------------------------------------------------------------------

export interface NestMicroserviceEntry {
  type: "MessagePattern" | "EventPattern";
  pattern: string;
  handler: string;
  controller: string;
  file: string;
}

export interface NestMicroserviceMapResult {
  patterns: NestMicroserviceEntry[];
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestMicroserviceMap(
  repo: string,
  options?: { max_patterns?: number },
): Promise<NestMicroserviceMapResult> {
  const index = await requireNestCodeIndex(repo);

  const maxPatterns = options?.max_patterns ?? 300;
  const patterns: NestMicroserviceEntry[] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  // Microservice patterns are typically in controller files (hybrid apps)
  const controllerFiles = index.files.filter(
    (f) => f.path.endsWith(".controller.ts") || f.path.endsWith(".controller.js"),
  );

  for (const file of controllerFiles) {
    if (patterns.length >= maxPatterns) { truncated = true; break; }
    const source = await readNestSource(index, file.path, errors);
    if (source === undefined) continue;

    // Quick substring filter
    if (!/@(MessagePattern|EventPattern)/.test(source)) continue;

    const classRanges = findNestClassRanges(source);
    const calls = (["MessagePattern", "EventPattern"] as const)
      .flatMap((type) =>
        findDecoratorCalls(source, type).map((call) => ({ ...call, type })),
      )
      .sort((left, right) => left.start - right.start);
    for (const call of calls) {
      const owner = findClassAtPosition(classRanges, call.start);
      const handlerMatch =
        /^\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/.exec(
          source.slice(call.end),
        );
      if (!handlerMatch) continue;
      if (patterns.length >= maxPatterns) { truncated = true; break; }
      const firstArg = stripLeadingNestComments(firstNestDecoratorArgument(call.args));
      const stringPattern = /^['"`]([^'"`]+)['"`]$/.exec(firstArg)?.[1];
      patterns.push({
        type: call.type,
        pattern: stringPattern ?? firstArg,
        handler: handlerMatch[1]!,
        controller: owner?.name ?? "UnknownController",
        file: file.path,
      });
    }
  }

  return {
    patterns,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

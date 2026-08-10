import { readNestSource, requireNestCodeIndex } from "./shared.js";
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

    const classMatch = /class\s+(\w+)/.exec(source);
    const controller = classMatch?.[1] ?? "UnknownController";

    const patternRe = /@(MessagePattern|EventPattern)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = patternRe.exec(source)) !== null) {
      if (patterns.length >= maxPatterns) { truncated = true; break; }
      patterns.push({
        type: m[1]! as "MessagePattern" | "EventPattern",
        pattern: m[2]!,
        handler: m[3]!,
        controller,
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

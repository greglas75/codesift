import {
  findClassAtPosition,
  findDecoratedClass,
  findDecoratorCalls,
  findNestClassRanges,
  isNodeModulesPath,
  maskNestSource,
  readNestSource,
  requireNestCodeIndex,
} from "./shared.js";
import type { NestToolError } from "../nest-tools.js";

// ---------------------------------------------------------------------------
// Wave 3 Feature 2: nest_queue_map — Bull / BullMQ queue processor discovery
// ---------------------------------------------------------------------------

export interface NestQueueProcessor {
  processor_class: string;
  queue_name: string;
  file: string;
  handlers: Array<{
    decorator: "@Process" | "@OnQueueActive" | "@OnQueueCompleted" | "@OnQueueFailed" | "@OnQueueStalled" | "@OnQueueWaiting" | "@OnQueueProgress" | "@OnQueueError";
    handler: string;
    job_name?: string; // For @Process('specific-job')
  }>;
}

export interface NestQueueMapResult {
  processors: NestQueueProcessor[];
  /** Consumers that inject @InjectQueue('name') — producer side */
  producers: Array<{ class_name: string; queue_name: string; file: string }>;
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestQueueMap(
  repo: string,
  options?: { max_processors?: number },
): Promise<NestQueueMapResult> {
  const index = await requireNestCodeIndex(repo);

  const maxProcessors = options?.max_processors ?? 200;
  const processors: NestQueueProcessor[] = [];
  const producers: NestQueueMapResult["producers"] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  // Scan .ts/.js files for @Processor or @InjectQueue decorators
  const candidateFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".ts") && !f.path.endsWith(".js")) return false;
    if (/\.(spec|test)\./.test(f.path)) return false;
    if (isNodeModulesPath(f.path)) return false;
    return true;
  });

  candidateFilesLoop: for (const file of candidateFiles) {
    const source = await readNestSource(index, file.path, errors);
    if (source === undefined) continue;

    if (!/@Processor|@InjectQueue/.test(source)) continue;

    const classRanges = findNestClassRanges(source);
    for (const call of findDecoratorCalls(source, "Processor")) {
      const owner = findDecoratedClass(classRanges, call);
      if (!owner) continue;
      if (processors.length >= maxProcessors) {
        truncated = true;
        break candidateFilesLoop;
      }

      const queueName = /^\s*['"`]([^'"`]+)['"`]/.exec(call.args)?.[1] ?? "default";
      const classBody = source.slice(owner.bodyStart + 1, owner.end - 1);
      const maskedBody = maskNestSource(classBody);
      const handlers: NestQueueProcessor["handlers"] = [];
      const handlerRe = /@(Process|OnQueueActive|OnQueueCompleted|OnQueueFailed|OnQueueStalled|OnQueueWaiting|OnQueueProgress|OnQueueError)\s*\(\s*(?:['"`]([^'"`]+)['"`]|\{([^}]*)\})?\s*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g;
      let handlerMatch: RegExpExecArray | null;
      while ((handlerMatch = handlerRe.exec(classBody)) !== null) {
        if (maskedBody[handlerMatch.index] !== "@") continue;
        const objectArgs = handlerMatch[3] ?? "";
        const jobName =
          handlerMatch[2] ?? /\bname:\s*['"`]([^'"`]+)['"`]/.exec(objectArgs)?.[1];
        handlers.push({
          decorator: ("@" + handlerMatch[1]!) as NestQueueProcessor["handlers"][number]["decorator"],
          handler: handlerMatch[4]!,
          ...(jobName ? { job_name: jobName } : {}),
        });
      }

      processors.push({
        processor_class: owner.name,
        queue_name: queueName,
        file: file.path,
        handlers,
      });
    }

    for (const call of findDecoratorCalls(source, "InjectQueue")) {
      const queueName = /^\s*['"`]([^'"`]+)['"`]/.exec(call.args)?.[1];
      if (!queueName) continue;
      const owner = findClassAtPosition(classRanges, call.start);
      producers.push({
        class_name: owner?.name ?? "UnknownClass",
        queue_name: queueName,
        file: file.path,
      });
    }
  }

  return {
    processors,
    producers,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

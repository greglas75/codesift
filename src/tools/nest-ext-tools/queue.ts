import {
  findClassAtPosition,
  findDecoratedClass,
  findDecoratorCalls,
  findNestClassRanges,
  findNestMethodAfter,
  isNodeModulesPath,
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
    decorator: "@Process" | "@OnQueueActive" | "@OnQueueCompleted" | "@OnQueueFailed" | "@OnQueueStalled" | "@OnQueueWaiting" | "@OnQueueProgress" | "@OnQueueError" | "WorkerHost.process";
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
  options?: { max_processors?: number; max_producers?: number },
): Promise<NestQueueMapResult> {
  const index = await requireNestCodeIndex(repo);

  const maxProcessors = options?.max_processors ?? 200;
  const maxProducers = options?.max_producers ?? 200;
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
      const handlers: NestQueueProcessor["handlers"] = [];
      const handlerDecorators = [
        "Process", "OnQueueActive", "OnQueueCompleted", "OnQueueFailed",
        "OnQueueStalled", "OnQueueWaiting", "OnQueueProgress", "OnQueueError",
      ] as const;
      for (const decorator of handlerDecorators) {
        for (const handlerCall of findDecoratorCalls(source, decorator)) {
          if (handlerCall.start < owner.bodyStart || handlerCall.start >= owner.end) continue;
          const method = findNestMethodAfter(source, handlerCall.end);
          if (!method || method.start >= owner.end) continue;
          const objectArgs = /^\s*\{([\s\S]*)\}\s*$/.exec(handlerCall.args)?.[1] ?? "";
        const jobName =
            /^\s*['"`]([^'"`]+)['"`]/.exec(handlerCall.args)?.[1] ??
            /\bname:\s*['"`]([^'"`]+)['"`]/.exec(objectArgs)?.[1];
          handlers.push({
            decorator: `@${decorator}`,
            handler: method.name,
            ...(jobName ? { job_name: jobName } : {}),
          });
        }
      }

      const classHeader = source.slice(owner.start, owner.bodyStart);
      if (/\bextends\s+WorkerHost\b/.test(classHeader)) {
        const processMethod = /(?:^|\n)\s*(?:(?:public|protected)\s+)?(?:async\s+)?process\s*\(/m.exec(
          source.slice(owner.bodyStart + 1, owner.end - 1),
        );
        if (processMethod) {
          handlers.push({ decorator: "WorkerHost.process", handler: "process" });
        }
      }

      processors.push({
        processor_class: owner.name,
        queue_name: queueName,
        file: file.path,
        handlers,
      });
    }

    for (const call of findDecoratorCalls(source, "InjectQueue")) {
      if (producers.length >= maxProducers) { truncated = true; break; }
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

import { readNestSource, requireNestCodeIndex } from "./shared.js";
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
    if (f.path.includes("/node_modules/")) return false;
    return true;
  });

  for (const file of candidateFiles) {
    if (processors.length >= maxProcessors) { truncated = true; break; }
    const source = await readNestSource(index, file.path, errors);
    if (source === undefined) continue;

    // Quick substring filter
    if (!/@Processor|@InjectQueue/.test(source)) continue;

    // --- Parse @Processor('queue-name') classes ---
    const procRe = /@Processor\s*\(\s*(?:['"`]([^'"`]+)['"`])?\s*\)\s*(?:export\s+)?class\s+(\w+)/g;
    let pm: RegExpExecArray | null;
    while ((pm = procRe.exec(source)) !== null) {
      if (processors.length >= maxProcessors) { truncated = true; break; }
      const queueName = pm[1] ?? "default";
      const processorClass = pm[2]!;

      // Find the class body (forward scan for @Process handlers)
      const classStart = pm.index + pm[0].length;
      const nextClassMatch = /(?:export\s+)?class\s+\w+/.exec(source.slice(classStart));
      const classEnd = nextClassMatch ? classStart + nextClassMatch.index : source.length;
      const classBody = source.slice(classStart, classEnd);

      const handlers: NestQueueProcessor["handlers"] = [];
      const handlerDecorators: Array<[string, NestQueueProcessor["handlers"][number]["decorator"]]> = [
        ["Process", "@Process"],
        ["OnQueueActive", "@OnQueueActive"],
        ["OnQueueCompleted", "@OnQueueCompleted"],
        ["OnQueueFailed", "@OnQueueFailed"],
        ["OnQueueStalled", "@OnQueueStalled"],
        ["OnQueueWaiting", "@OnQueueWaiting"],
        ["OnQueueProgress", "@OnQueueProgress"],
        ["OnQueueError", "@OnQueueError"],
      ];

      for (const [decName, decType] of handlerDecorators) {
        // Match decorator with optional job name arg, then method name (skip modifiers)
        const re = new RegExp(
          `@${decName}\\s*\\(\\s*(?:['"\`]([^'"\`]+)['"\`])?\\s*\\)\\s*\\n?\\s*(?:(?:public|private|protected|static)\\s+)?(?:async\\s+)?(\\w+)\\s*\\(`,
          "g",
        );
        let hm: RegExpExecArray | null;
        while ((hm = re.exec(classBody)) !== null) {
          const jobName = hm[1];
          const handler = hm[2]!;
          handlers.push({
            decorator: decType,
            handler,
            ...(jobName ? { job_name: jobName } : {}),
          });
        }
      }

      processors.push({
        processor_class: processorClass,
        queue_name: queueName,
        file: file.path,
        handlers,
      });
    }

    // --- Parse @InjectQueue('queue-name') producers ---
    const injectRe = /@InjectQueue\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    let im: RegExpExecArray | null;
    while ((im = injectRe.exec(source)) !== null) {
      const queueName = im[1]!;
      // Find the enclosing class
      const beforeInject = source.slice(0, im.index);
      const lastClass = beforeInject.match(/(?:export\s+)?class\s+(\w+)[\s\S]*$/);
      const className = lastClass ? lastClass[1]! : "UnknownClass";
      producers.push({ class_name: className, queue_name: queueName, file: file.path });
    }
  }

  return {
    processors,
    producers,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

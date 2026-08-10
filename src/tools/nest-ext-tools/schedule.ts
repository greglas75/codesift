import {
  findClassAtPosition,
  findNestClassRanges,
  maskNestSource,
  readNestSource,
  requireNestCodeIndex,
} from "./shared.js";
import type { NestToolError } from "../nest-tools.js";

// ---------------------------------------------------------------------------
// G7+G8: nest_schedule_map — @Cron/@Interval/@Timeout/@OnEvent discovery
// ---------------------------------------------------------------------------

export interface NestScheduledEntry {
  class_name: string;
  file: string;
  handler: string;
  decorator: "@Cron" | "@Interval" | "@Timeout" | "@OnEvent";
  expression?: string;
  interval_ms?: number;
}

export interface NestScheduleMapResult {
  entries: NestScheduledEntry[];
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestScheduleMap(
  repo: string,
  options?: { max_schedules?: number; max_files_scanned?: number },
): Promise<NestScheduleMapResult> {
  const index = await requireNestCodeIndex(repo);

  const maxSchedules = options?.max_schedules ?? 300;
  const maxFilesScanned = options?.max_files_scanned ?? 2000;
  const entries: NestScheduledEntry[] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  // Pre-filter: only .ts/.js files, exclude spec/test files, prefer .service.ts
  const candidateFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".ts") && !f.path.endsWith(".js")) return false;
    if (/\.(spec|test)\./.test(f.path)) return false;
    if (f.path.includes("/node_modules/")) return false;
    return true;
  });

  let scanned = 0;
  for (const file of candidateFiles) {
    if (scanned >= maxFilesScanned) { truncated = true; break; }
    if (entries.length >= maxSchedules) { truncated = true; break; }
    scanned++;

    const source = await readNestSource(index, file.path, errors);
    if (source === undefined) continue;

    // Quick substring filter to skip files without schedule/event decorators
    if (!/@Cron|@Interval|@Timeout|@OnEvent/.test(source)) continue;

    const classRanges = findNestClassRanges(source);
    const masked = maskNestSource(source);

    // Parse each decorator type
    const decoratorPatterns: Array<{
      type: NestScheduledEntry["decorator"];
      regex: RegExp;
      parseArg: (arg: string) => { expression?: string; interval_ms?: number };
    }> = [
      {
        type: "@Cron",
        regex: /@Cron\s*\(\s*['"`]([^'"`]+)['"`][^)]*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g,
        parseArg: (arg) => ({ expression: arg }),
      },
      {
        type: "@Interval",
        regex: /@Interval\s*\(\s*([0-9][0-9_]*(?:\.[0-9_]+)?(?:e[+-]?[0-9_]+)?)\s*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/gi,
        parseArg: parseDelayLiteral,
      },
      {
        type: "@Timeout",
        regex: /@Timeout\s*\(\s*([0-9][0-9_]*(?:\.[0-9_]+)?(?:e[+-]?[0-9_]+)?)\s*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/gi,
        parseArg: parseDelayLiteral,
      },
      {
        type: "@OnEvent",
        regex: /@OnEvent\s*\(\s*['"`]([^'"`]+)['"`][^)]*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g,
        parseArg: (arg) => ({ expression: arg }),
      },
    ];

    for (const { type, regex, parseArg } of decoratorPatterns) {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(source)) !== null) {
        if (masked[m.index] !== "@") continue;
        const owner = findClassAtPosition(classRanges, m.index);
        if (entries.length >= maxSchedules) { truncated = true; break; }
        const arg = m[1]!;
        const handler = m[2]!;
        entries.push({
          class_name: owner?.name ?? "UnknownClass",
          file: file.path,
          handler,
          decorator: type,
          ...parseArg(arg),
        });
      }
    }

    // R-12 fix: fallback — catch constant/expression args like @Cron(CronExpression.EVERY_10_SECONDS)
    // These are not captured by the literal-specific regexes above.
    const fallbackRe = /@(Cron|Interval|Timeout|OnEvent)\s*\(\s*([A-Z][\w.]+)\s*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g;
    let fm: RegExpExecArray | null;
    while ((fm = fallbackRe.exec(source)) !== null) {
      if (masked[fm.index] !== "@") continue;
      const owner = findClassAtPosition(classRanges, fm.index);
      if (entries.length >= maxSchedules) { truncated = true; break; }
      const handler = fm[3]!;
      const decorator = `@${fm[1]!}` as NestScheduledEntry["decorator"];
      const className = owner?.name ?? "UnknownClass";
      if (
        entries.some(
          (entry) =>
            entry.file === file.path &&
            entry.class_name === className &&
            entry.handler === handler &&
            entry.decorator === decorator,
        )
      ) {
        continue;
      }
      entries.push({
        class_name: className,
        file: file.path,
        handler,
        decorator,
        expression: fm[2]!, // raw constant expression, e.g. "CronExpression.EVERY_10_SECONDS"
      });
    }
  }

  return {
    entries,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

function parseDelayLiteral(arg: string): { expression?: string; interval_ms?: number } {
  const value = Number(arg.replaceAll("_", ""));
  if (Number.isSafeInteger(value) && value >= 0) {
    return { interval_ms: value };
  }
  return { expression: arg };
}

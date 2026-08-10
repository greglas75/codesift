import {
  findClassAtPosition,
  findDecoratorCalls,
  findNestClassRanges,
  findNestMethodAfter,
  firstNestDecoratorArgument,
  readNestSource,
  requireNestCodeIndex,
  splitTopLevelNestArguments,
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
    const calls = (["Cron", "Interval", "Timeout", "OnEvent"] as const)
      .flatMap((name) =>
        findDecoratorCalls(source, name).map((call) => ({ ...call, name })),
      )
      .sort((left, right) => left.start - right.start);
    for (const call of calls) {
      const owner = findClassAtPosition(classRanges, call.start);
      if (entries.length >= maxSchedules) { truncated = true; break; }
      const method = findNestMethodAfter(source, call.end);
      if (!method || (owner && method.start >= owner.end)) continue;
      const args = splitTopLevelNestArguments(call.args);
      const first = firstNestDecoratorArgument(call.args);
      const decorator = `@${call.name}` as NestScheduledEntry["decorator"];
      const rawValue =
        (call.name === "Interval" || call.name === "Timeout") && /^\s*['"`]/.test(first)
          ? args[1]
          : first;
      if (!rawValue) continue;
      const stringValue = /^\s*['"`]([^'"`]+)['"`]\s*$/.exec(rawValue)?.[1];
      const parsed =
        call.name === "Interval" || call.name === "Timeout"
          ? parseDelayLiteral(stringValue ?? rawValue)
          : { expression: stringValue ?? rawValue };
      const className = owner?.name ?? "UnknownClass";
      if (entries.some((entry) =>
        entry.file === file.path &&
        entry.class_name === className &&
        entry.handler === method.name &&
        entry.decorator === decorator
      )) continue;
      entries.push({
        class_name: className,
        file: file.path,
        handler: method.name,
        decorator,
        ...parsed,
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

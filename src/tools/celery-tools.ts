/**
 * trace_celery_chain — Celery task discovery, canvas operators, call sites.
 *
 * Discovers all Celery tasks, their retry/rate-limit policies, canvas
 * composition (chain, group, chord), and every place they're invoked via
 * .delay() or .apply_async().
 *
 * This answers the question: "If I change this task, what breaks?"
 */
import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";

export interface CeleryTask {
  name: string;
  file: string;
  line: number;
  decorator: string;
  bind: boolean;
  max_retries?: number;
  retry_backoff?: boolean | number;
  rate_limit?: string;
  queue?: string;
  callers: Array<{
    file: string;
    line: number;
    kind: "delay" | "apply_async" | "canvas" | "direct";
    context: string;
  }>;
}

export interface CeleryCanvasUsage {
  file: string;
  line: number;
  operator: "chain" | "group" | "chord" | "signature" | "s" | "si";
  context: string;
}

export interface CeleryResult {
  tasks: CeleryTask[];
  canvas_usages: CeleryCanvasUsage[];
  total_tasks: number;
  total_call_sites: number;
  orphan_tasks: string[]; // tasks defined but never called
}

// --- Detection patterns ---

const TASK_DECORATOR_RE = /@(?:\w+\.)?(?:task|shared_task)\b/;
const BIND_RE = /bind\s*=\s*True/;
const MAX_RETRIES_RE = /max_retries\s*=\s*(\d+)/;
const RETRY_BACKOFF_RE = /retry_backoff\s*=\s*(True|False|\d+)/;
const RATE_LIMIT_RE = /rate_limit\s*=\s*['"]([^'"]+)['"]/;
const QUEUE_RE = /queue\s*=\s*['"]([^'"]+)['"]/;

// Call site patterns
const DELAY_RE = /(\w+)\.delay\s*\(/g;
const APPLY_ASYNC_RE = /(\w+)\.apply_async\s*\(/g;
const CANVAS_S_RE = /(\w+)\.s\s*\(/g;
const CANVAS_SI_RE = /(\w+)\.si\s*\(/g;

// Canvas operator invocations
const CHAIN_RE = /\bchain\s*\(/g;
const GROUP_RE = /\bgroup\s*\(/g;
const CHORD_RE = /\bchord\s*\(/g;
const SIGNATURE_RE = /\bsignature\s*\(/g;

/**
 * Discover Celery tasks and their call sites.
 */
export async function traceCeleryChain(
  repo: string,
  options?: {
    file_pattern?: string;
    task_name?: string; // restrict to one task for focused analysis
  },
): Promise<CeleryResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const filePattern = options?.file_pattern;
  const targetTaskName = options?.task_name;

  // 1. Find all Celery task definitions
  const tasks: CeleryTask[] = [];
  const taskByName = new Map<string, CeleryTask>();

  for (const sym of index.symbols) {
    if (!sym.file.endsWith(".py")) continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;
    if (!sym.decorators || sym.decorators.length === 0) continue;

    // Check if any decorator is a Celery task decorator
    const taskDec = sym.decorators.find((d) => TASK_DECORATOR_RE.test(d));
    if (!taskDec) continue;

    // Apply task_name filter if set
    if (targetTaskName && sym.name !== targetTaskName) continue;

    const task: CeleryTask = {
      name: sym.name,
      file: sym.file,
      line: sym.start_line,
      decorator: taskDec,
      bind: BIND_RE.test(taskDec),
      callers: [],
    };

    const maxRetries = taskDec.match(MAX_RETRIES_RE);
    if (maxRetries) task.max_retries = Number(maxRetries[1]);

    const retryBackoff = taskDec.match(RETRY_BACKOFF_RE);
    if (retryBackoff) {
      const val = retryBackoff[1]!;
      task.retry_backoff = val === "True" ? true : val === "False" ? false : Number(val);
    }

    const rateLimit = taskDec.match(RATE_LIMIT_RE);
    if (rateLimit) task.rate_limit = rateLimit[1];

    const queue = taskDec.match(QUEUE_RE);
    if (queue) task.queue = queue[1];

    tasks.push(task);
    taskByName.set(sym.name, task);
  }

  // 2. Find all call sites across the codebase
  let totalCallSites = 0;
  const canvasUsages: CeleryCanvasUsage[] = [];

  for (const sym of index.symbols) {
    if (!sym.file.endsWith(".py")) continue;
    if (!sym.source) continue;

    const source = sym.source;

    // Scan for .delay() calls
    scanCallPattern(source, DELAY_RE, sym, "delay", taskByName);
    scanCallPattern(source, APPLY_ASYNC_RE, sym, "apply_async", taskByName);
    scanCallPattern(source, CANVAS_S_RE, sym, "canvas", taskByName);
    scanCallPattern(source, CANVAS_SI_RE, sym, "canvas", taskByName);

    // Canvas operators
    const canvasPatterns: Array<{ re: RegExp; op: CeleryCanvasUsage["operator"] }> = [
      { re: CHAIN_RE, op: "chain" },
      { re: GROUP_RE, op: "group" },
      { re: CHORD_RE, op: "chord" },
      { re: SIGNATURE_RE, op: "signature" },
    ];

    for (const { re, op } of canvasPatterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        const lineStart = source.lastIndexOf("\n", m.index) + 1;
        const lineEnd = source.indexOf("\n", m.index);
        const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
        const linesBefore = source.slice(0, m.index).split("\n").length - 1;
        canvasUsages.push({
          file: sym.file,
          line: sym.start_line + linesBefore,
          operator: op,
          context: line.slice(0, 200),
        });
      }
    }
  }

  // Count total call sites across all tasks
  for (const task of tasks) {
    totalCallSites += task.callers.length;
  }

  // Orphan tasks: defined but never called
  const orphanTasks = tasks.filter((t) => t.callers.length === 0).map((t) => t.name);

  return {
    tasks,
    canvas_usages: canvasUsages,
    total_tasks: tasks.length,
    total_call_sites: totalCallSites,
    orphan_tasks: orphanTasks,
  };
}

function scanCallPattern(
  source: string,
  pattern: RegExp,
  sym: CodeSymbol,
  kind: "delay" | "apply_async" | "canvas",
  taskByName: Map<string, CeleryTask>,
): void {
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) {
    const taskName = m[1]!;
    const task = taskByName.get(taskName);
    if (!task) continue;
    // Skip self-references (task calling itself)
    if (sym.file === task.file && sym.name === task.name) continue;

    const lineStart = source.lastIndexOf("\n", m.index) + 1;
    const lineEnd = source.indexOf("\n", m.index);
    const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
    const linesBefore = source.slice(0, m.index).split("\n").length - 1;

    task.callers.push({
      file: sym.file,
      line: sym.start_line + linesBefore,
      kind,
      context: line.slice(0, 200),
    });
  }
}

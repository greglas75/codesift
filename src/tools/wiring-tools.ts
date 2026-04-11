/**
 * Framework wiring discovery — find implicit control flow connections.
 * Django signals, Celery tasks, middleware chains, management commands,
 * Flask extensions, FastAPI event handlers.
 */
import { getCodeIndex } from "./index-tools.js";

export interface WiringEntry {
  type: "signal" | "task" | "middleware" | "command" | "extension" | "event_handler" | "task_call";
  name: string;
  file: string;
  line: number;
  detail: string;
}

export interface WiringResult {
  entries: WiringEntry[];
  total: number;
  by_type: Record<string, number>;
}

// --- Detection patterns ---

// Django signals: @receiver(post_save, sender=Model)
const DJANGO_RECEIVER_RE = /@receiver\s*\(\s*(\w+)(?:\s*,\s*sender\s*=\s*(\w+))?\)/;
const SIGNAL_CONNECT_RE = /(\w+)\.connect\s*\(\s*(\w+)/;

// Celery tasks: @app.task, @shared_task, @celery.task
const CELERY_TASK_DECORATOR_RE = /@(?:\w+\.)?(?:task|shared_task)\b/;
// Celery task calls: .delay(), .apply_async()
const CELERY_CALL_RE = /(\w+)\.(delay|apply_async|s|si|signature)\s*\(/;

// Django middleware: MIDDLEWARE list in settings
const MIDDLEWARE_RE = /MIDDLEWARE\s*=\s*\[([^\]]*)\]/s;

// Django management commands: class Command(BaseCommand)
const MANAGEMENT_CMD_RE = /class\s+Command\s*\(\s*(?:\w+\.)?BaseCommand\s*\)/;

// Flask extensions: .init_app()
const FLASK_INIT_APP_RE = /(\w+)\.init_app\s*\(\s*(\w+)\s*\)/;

// FastAPI event handlers: @app.on_event("startup")
const FASTAPI_EVENT_RE = /@\w+\.on_event\s*\(\s*['"](\w+)['"]\s*\)/;

/**
 * Discover implicit framework wiring across a Python codebase.
 */
export async function findFrameworkWiring(
  repo: string,
  options?: {
    file_pattern?: string;
  },
): Promise<WiringResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const filePattern = options?.file_pattern;
  const entries: WiringEntry[] = [];

  for (const sym of index.symbols) {
    if (!sym.file.endsWith(".py")) continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;

    const source = sym.source ?? "";
    const decorators = sym.decorators ?? [];

    // Django signals
    for (const dec of decorators) {
      const sigMatch = DJANGO_RECEIVER_RE.exec(dec);
      if (sigMatch) {
        entries.push({
          type: "signal",
          name: sym.name,
          file: sym.file,
          line: sym.start_line,
          detail: `@receiver(${sigMatch[1]}${sigMatch[2] ? `, sender=${sigMatch[2]}` : ""})`,
        });
      }
    }

    // Signal.connect()
    const connectMatch = SIGNAL_CONNECT_RE.exec(source);
    if (connectMatch) {
      entries.push({
        type: "signal",
        name: connectMatch[2]!,
        file: sym.file,
        line: sym.start_line,
        detail: `${connectMatch[1]}.connect(${connectMatch[2]})`,
      });
    }

    // Celery tasks
    for (const dec of decorators) {
      if (CELERY_TASK_DECORATOR_RE.test(dec)) {
        entries.push({
          type: "task",
          name: sym.name,
          file: sym.file,
          line: sym.start_line,
          detail: dec,
        });
      }
    }

    // Celery task calls
    const callMatch = CELERY_CALL_RE.exec(source);
    if (callMatch) {
      entries.push({
        type: "task_call",
        name: callMatch[1]!,
        file: sym.file,
        line: sym.start_line,
        detail: `${callMatch[1]}.${callMatch[2]}()`,
      });
    }

    // Management commands
    if (MANAGEMENT_CMD_RE.test(source) && sym.file.includes("management/commands/")) {
      const cmdName = sym.file.split("/").pop()?.replace(".py", "") ?? sym.name;
      entries.push({
        type: "command",
        name: cmdName,
        file: sym.file,
        line: sym.start_line,
        detail: `manage.py ${cmdName}`,
      });
    }

    // Flask init_app
    const initMatch = FLASK_INIT_APP_RE.exec(source);
    if (initMatch) {
      entries.push({
        type: "extension",
        name: initMatch[1]!,
        file: sym.file,
        line: sym.start_line,
        detail: `${initMatch[1]}.init_app(${initMatch[2]})`,
      });
    }

    // FastAPI event handlers
    for (const dec of decorators) {
      const eventMatch = FASTAPI_EVENT_RE.exec(dec);
      if (eventMatch) {
        entries.push({
          type: "event_handler",
          name: sym.name,
          file: sym.file,
          line: sym.start_line,
          detail: `on_event("${eventMatch[1]}")`,
        });
      }
    }

    // Django middleware (from settings)
    if (sym.name === "MIDDLEWARE" || sym.kind === "constant") {
      const mwMatch = MIDDLEWARE_RE.exec(source);
      if (mwMatch) {
        const middlewares = mwMatch[1]!
          .split(",")
          .map((m) => m.trim().replace(/['"]/g, ""))
          .filter((m) => m.length > 0);
        for (const mw of middlewares) {
          entries.push({
            type: "middleware",
            name: mw.split(".").pop() ?? mw,
            file: sym.file,
            line: sym.start_line,
            detail: mw,
          });
        }
      }
    }
  }

  const by_type: Record<string, number> = {};
  for (const e of entries) {
    by_type[e.type] = (by_type[e.type] ?? 0) + 1;
  }

  return { entries, total: entries.length, by_type };
}

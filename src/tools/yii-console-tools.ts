/**
 * Yii2 console command inventory (N4).
 *
 * Console controllers in Yii2 (extends yii\\console\\Controller) are
 * typically cron jobs, queue workers, or one-off ops scripts. They're
 * a high-leverage surface to audit because they:
 *   - run with elevated privileges (no HTTP auth gate)
 *   - frequently lack the test coverage the web side has
 *   - are the most common place to find unbounded ->all() reads
 *
 * The tool inventories every console controller and its action methods.
 * For each action it surfaces:
 *   - declared CLI argument list (extracted from the method signature)
 *   - whether the action accepts variadic ...$args
 *   - the docblock (often the only documentation for a command)
 *   - flags (warnings / hints) about specific risks:
 *       - exits-without-return-status: action returns void / nothing,
 *         so cron schedulers can't tell success from failure
 *       - has-unbounded-all: ->all() found in body without ->limit /
 *         ->batch / ->each (cron killer)
 *       - has-no-error-handling: no try/catch around the body
 *
 * Output is structured per-controller so consumers can:
 *   - cross-reference with crontab / SystemCron entries
 *   - flag commands that need test coverage
 *   - prioritize commands that look risky
 */

import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface YiiConsoleAction {
  name: string;
  /** Yii2 maps actionFooBar() → CLI command "foo-bar"; we surface both. */
  cli_id: string;
  /** Parameters declared in the action signature, in declaration order. */
  arguments: Array<{
    name: string;
    type: string | null;
    default: string | null;
    required: boolean;
  }>;
  variadic: boolean;
  docstring: string | null;
  start_line: number;
  flags: ConsoleActionFlag[];
}

export type ConsoleActionFlag =
  | "exits-without-return-status"
  | "has-unbounded-all"
  | "has-no-error-handling"
  | "uses-output-via-echo";

export interface YiiConsoleController {
  /** Class name (e.g. "BuildController"). */
  class: string;
  /** CLI controller id (e.g. "build" — actionRun in BuildController → "build/run"). */
  cli_id: string;
  file: string;
  actions: YiiConsoleAction[];
}

export interface YiiConsoleAudit {
  repo: string;
  total_controllers: number;
  total_actions: number;
  controllers: YiiConsoleController[];
  /** Cross-controller summary: actions ranked by risk (count of flags). */
  high_risk_actions: Array<{
    controller: string;
    action: string;
    cli_id: string;
    flags: ConsoleActionFlag[];
  }>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const CONSOLE_BASE_NAMES = new Set(["Controller"]);

interface IndexLike {
  symbols: Array<{
    id?: string;
    name: string;
    kind: string;
    file: string;
    parent?: string | undefined;
    source?: string | undefined;
    extends?: string[] | undefined;
    docstring?: string | undefined;
    signature?: string | undefined;
    start_line: number;
    end_line: number;
  }>;
}

/**
 * Detect whether a class extends yii\\console\\Controller (or any descendant).
 * Combines a path heuristic — files under `console/`, `commands/`, or
 * `*Console*Controller.php` — with the structural extends check, so we
 * don't pick up web controllers that happen to extend the same base
 * `Controller` class but live under controllers/.
 */
function isConsoleControllerClass(
  cls: { name: string; file: string; extends?: string[] | undefined; source?: string | undefined },
  index: IndexLike,
): boolean {
  // Path heuristic: Yii2 advanced/standard convention puts console code
  // under console/controllers/ or commands/. tgm-panel uses commands/.
  // We accept either.
  const inConsoleDir =
    /(?:^|\/)(?:console\/controllers|commands)\//.test(cls.file);
  if (!inConsoleDir) return false;

  // Structural extends check. For the path-matched files we want to
  // confirm the class actually extends a Yii2 Controller (the common
  // base) — picking up vendor classes that happen to live under
  // commands/ is a false positive risk that walking the chain prevents.
  return walkExtendsForConsole(cls, index, new Set(), 0);
}

function walkExtendsForConsole(
  cls: { name: string; extends?: string[] | undefined; source?: string | undefined },
  index: IndexLike,
  visited: Set<string>,
  depth: number,
): boolean {
  if (depth > 5) return false;
  if (visited.has(cls.name)) return false;
  visited.add(cls.name);

  const exts = cls.extends ?? [];
  for (const baseFqcn of exts) {
    const last = baseFqcn.split(/[\\\\]+/).pop() ?? baseFqcn;
    if (CONSOLE_BASE_NAMES.has(last)) return true;
    // Also accept the explicit "ConsoleController" suffix used by some
    // teams (matches the common convention where console controllers
    // share a project-specific base class).
    if (last === "ConsoleController") return true;
    const baseSym = index.symbols.find(
      (s) => s.kind === "class" && s.name === last,
    );
    if (
      baseSym &&
      walkExtendsForConsole(baseSym, index, visited, depth + 1)
    ) {
      return true;
    }
  }
  // Fallback for stale indexes without extends metadata.
  if (!cls.extends && cls.source) {
    return /extends\s+(?:\\?yii\\console\\Controller|Controller)\b/.test(
      cls.source,
    );
  }
  return false;
}

export async function analyzeYiiConsoleCommands(
  repo: string,
  options?: { controller_id?: string },
): Promise<YiiConsoleAudit> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const consoleClasses = index.symbols.filter((s) => {
    if (s.kind !== "class") return false;
    if (!s.file.endsWith(".php")) return false;
    if (!s.name.endsWith("Controller")) return false;
    if (!isConsoleControllerClass(s, index)) return false;
    return true;
  });

  const controllers: YiiConsoleController[] = [];

  for (const cls of consoleClasses) {
    const cliId = pascalToKebab(cls.name.replace(/Controller$/, ""));
    if (options?.controller_id && cliId !== options.controller_id) continue;

    const actionMethods = index.symbols.filter(
      (s) =>
        s.parent === cls.id &&
        s.kind === "method" &&
        s.name.startsWith("action") &&
        s.name.length > "action".length,
    );

    const actions: YiiConsoleAction[] = actionMethods.map((m) => {
      const actionId = pascalToKebab(m.name.slice("action".length));
      const args = parseActionArguments(m.signature ?? "");
      const variadic = /\.{3}\$\w+/.test(m.signature ?? "");
      const flags = scanActionFlags(m.source ?? "", m.name);
      return {
        name: m.name,
        cli_id: actionId,
        arguments: args,
        variadic,
        docstring: m.docstring ?? null,
        start_line: m.start_line,
        flags,
      };
    });
    actions.sort((a, b) => a.name.localeCompare(b.name));

    controllers.push({
      class: cls.name,
      cli_id: cliId,
      file: cls.file,
      actions,
    });
  }

  controllers.sort((a, b) => a.cli_id.localeCompare(b.cli_id));

  // Cross-controller summary: actions with ≥2 flags, sorted by flag count.
  const highRisk: YiiConsoleAudit["high_risk_actions"] = [];
  for (const c of controllers) {
    for (const a of c.actions) {
      if (a.flags.length >= 2) {
        highRisk.push({
          controller: c.class,
          action: a.name,
          cli_id: `${c.cli_id}/${a.cli_id}`,
          flags: a.flags,
        });
      }
    }
  }
  highRisk.sort((a, b) => b.flags.length - a.flags.length);

  const totalActions = controllers.reduce((n, c) => n + c.actions.length, 0);

  return {
    repo,
    total_controllers: controllers.length,
    total_actions: totalActions,
    controllers,
    high_risk_actions: highRisk,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pascalToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Parse a method signature string like "(string $repo, int $limit = 10, ...$rest)"
 * into a structured argument list. Type and default are best-effort — we
 * preserve the source-side spelling, callers can normalize.
 */
function parseActionArguments(
  signature: string,
): YiiConsoleAction["arguments"] {
  if (!signature) return [];
  // Strip leading "(" and trailing "): ReturnType" → keep just the param list
  const inner = signature.replace(/^\(|\).*$/g, "");
  if (!inner.trim()) return [];

  const args: YiiConsoleAction["arguments"] = [];
  // Split on commas at top level only — parameters can have default values
  // containing commas (e.g. `array $cfg = [1, 2]`). For a CLI tool this is
  // rare so a comma-split + simple bracket-balance fixup is enough.
  const parts = splitParams(inner);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Skip variadic — handled separately by the caller via .test()
    if (/^\.{3}\$/.test(trimmed)) continue;

    // Extract: optional type + $name + optional `= default`
    const m = /^(?:([?\w\\|&]+)\s+)?\$(\w+)(?:\s*=\s*(.+))?$/.exec(trimmed);
    if (!m) continue;
    const type = m[1] ?? null;
    const name = m[2]!;
    const defaultValue = m[3]?.trim() ?? null;
    args.push({
      name,
      type,
      default: defaultValue,
      required: defaultValue === null,
    });
  }
  return args;
}

function splitParams(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const c of s) {
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function scanActionFlags(
  body: string,
  methodName: string,
): ConsoleActionFlag[] {
  const flags: ConsoleActionFlag[] = [];
  if (!body) return flags;

  // exits-without-return-status: actions that have no `return` statement OR
  // return only void/null. Yii2's ExitCode constants are the recommended
  // way to surface success/failure to the cron scheduler.
  const hasExitReturn = /\breturn\s+(?:ExitCode::|self::|static::)/.test(body);
  const hasIntReturn = /\breturn\s+(?:0|1|-?\d+)\s*;/.test(body);
  const hasAnyReturn = /\breturn\b/.test(body);
  if (!hasExitReturn && !hasIntReturn && !hasAnyReturn) {
    flags.push("exits-without-return-status");
  }

  // has-unbounded-all: ->all() with no ->limit / ->batch / ->each in
  // the same body. Same heuristic as the perf pattern.
  if (
    /->all\s*\(\s*\)/.test(body) &&
    !/->(?:limit|batch|each)\b/.test(body)
  ) {
    flags.push("has-unbounded-all");
  }

  // has-no-error-handling: no try/catch around the body. Cron jobs that
  // throw uncaught exceptions can leave their state half-written; at
  // minimum a top-level catch + ExitCode::OK / UNSPECIFIED_ERROR is
  // worth surfacing.
  if (!/\btry\s*\{/.test(body)) {
    flags.push("has-no-error-handling");
  }

  // uses-output-via-echo: directly printing via echo / print. The Yii2
  // idiom is `$this->stdout(...)` / `$this->stderr(...)` which respects
  // output piping and color settings. Skipped on actionHelp / actionInit
  // where echo is a fine choice.
  if (
    !/^action(?:Help|Init|Index)$/.test(methodName) &&
    /\b(?:echo|print)\s+(?!Yii::)/.test(body)
  ) {
    flags.push("uses-output-via-echo");
  }

  return flags;
}

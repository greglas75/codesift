import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeSymbol } from "../types.js";
import type { IndexSummary } from "../storage/sqlite-index-store.js";
import { findRepoSymbols, getIndexSummary } from "./index-tools.js";
import { traceRoute } from "./route-tools.js";

export interface DjangoViewSecurityAssessment {
  symbol_name: string;
  symbol_kind: CodeSymbol["kind"];
  file: string;
  line: number;
  route_path?: string;
  view_type: "function" | "class" | "method";
  decorators: string[];
  mixins: string[];
  auth_guards: string[];
  csrf_exempt: boolean;
  effective_auth_required: boolean;
  csrf_protected: boolean;
  authentication_middleware: boolean;
  session_middleware: boolean;
  security_middleware: boolean;
  notes: string[];
  confidence: "high" | "medium" | "low";
}

export interface DjangoViewSecurityResult {
  assessments: DjangoViewSecurityAssessment[];
  settings_files: string[];
  middleware: string[];
}

const AUTH_DECORATORS = [
  "login_required",
  "permission_required",
  "user_passes_test",
  "staff_member_required",
  "superuser_required",
];

const AUTH_MIXINS = [
  "LoginRequiredMixin",
  "PermissionRequiredMixin",
  "UserPassesTestMixin",
  "AccessMixin",
];

function hasDecorator(decorators: string[], name: string): boolean {
  return decorators.some((decorator) => {
    const normalized = decorator.trim().replace(/^@/, "");
    return normalized === name || normalized.startsWith(`${name}(`);
  });
}

function collectAuthGuards(decorators: string[], mixins: string[]): string[] {
  const guards = new Set<string>();
  for (const decorator of AUTH_DECORATORS) {
    if (hasDecorator(decorators, decorator)) guards.add(decorator);
  }
  for (const mixin of AUTH_MIXINS) {
    if (mixins.includes(mixin)) guards.add(mixin);
  }
  return [...guards];
}

function getSettingsFiles(index: IndexSummary, explicitSettingsFile?: string): string[] {
  if (explicitSettingsFile) return [explicitSettingsFile];
  return index.files
    .filter((file) => file.path.endsWith(".py"))
    .filter((file) => /\/settings\.py$|\/settings\/[\w_]+\.py$/.test(file.path))
    .map((file) => file.path);
}

async function collectMiddleware(index: IndexSummary, settingsFiles: string[]): Promise<string[]> {
  const middlewares = new Set<string>();
  for (const filePath of settingsFiles) {
    let source: string;
    try {
      source = await readFile(join(index.root, filePath), "utf-8");
    } catch {
      continue;
    }

    const match = source.match(/MIDDLEWARE\s*=\s*\[([\s\S]*?)\]/);
    if (!match?.[1]) continue;

    const entries = match[1]
      .split(",")
      .map((value) => value.trim().replace(/['"]/g, ""))
      .filter((value) => value.length > 0);
    for (const entry of entries) {
      middlewares.add(entry);
    }
  }
  return [...middlewares];
}

function classifyViewType(symbol: CodeSymbol): "function" | "class" | "method" {
  if (symbol.kind === "class") return "class";
  if (symbol.kind === "method") return "method";
  return "function";
}

function buildNotes(
  authGuards: string[],
  csrfExempt: boolean,
  middleware: string[],
): string[] {
  const notes: string[] = [];
  const authMiddleware = middleware.some((entry) => entry.endsWith("AuthenticationMiddleware"));
  const csrfMiddleware = middleware.some((entry) => entry.endsWith("CsrfViewMiddleware"));

  if (authGuards.length === 0) {
    if (authMiddleware) {
      notes.push("No auth decorator or mixin detected; AuthenticationMiddleware alone does not restrict access.");
    } else {
      notes.push("No auth decorator or mixin detected, and AuthenticationMiddleware was not found in settings.");
    }
  }

  if (csrfExempt) {
    notes.push("View is explicitly marked csrf_exempt.");
  } else if (!csrfMiddleware) {
    notes.push("CsrfViewMiddleware was not found in settings, so CSRF protection may be absent globally.");
  }

  return notes;
}

function buildAssessment(
  symbol: CodeSymbol,
  parentSymbol: CodeSymbol | undefined,
  middleware: string[],
  routePath?: string,
): DjangoViewSecurityAssessment {
  const decorators = [...(parentSymbol?.decorators ?? []), ...(symbol.decorators ?? [])];
  const mixins = symbol.kind === "class"
    ? [...(symbol.extends ?? [])]
    : [...(parentSymbol?.extends ?? [])];
  const authGuards = collectAuthGuards(decorators, mixins);
  const csrfExempt = hasDecorator(decorators, "csrf_exempt");
  const authenticationMiddleware = middleware.some((entry) => entry.endsWith("AuthenticationMiddleware"));
  const sessionMiddleware = middleware.some((entry) => entry.endsWith("SessionMiddleware"));
  const securityMiddleware = middleware.some((entry) => entry.endsWith("SecurityMiddleware"));
  const csrfProtected = !csrfExempt && middleware.some((entry) => entry.endsWith("CsrfViewMiddleware"));
  const notes = buildNotes(authGuards, csrfExempt, middleware);

  const assessment: DjangoViewSecurityAssessment = {
    symbol_name: symbol.name,
    symbol_kind: symbol.kind,
    file: symbol.file,
    line: symbol.start_line,
    view_type: classifyViewType(symbol),
    decorators,
    mixins,
    auth_guards: authGuards,
    csrf_exempt: csrfExempt,
    effective_auth_required: authGuards.length > 0,
    csrf_protected: csrfProtected,
    authentication_middleware: authenticationMiddleware,
    session_middleware: sessionMiddleware,
    security_middleware: securityMiddleware,
    notes,
    confidence: parentSymbol || routePath ? "high" : "medium",
  };
  if (routePath !== undefined) {
    assessment.route_path = routePath;
  }
  return assessment;
}

function dedupeAssessments(assessments: DjangoViewSecurityAssessment[]): DjangoViewSecurityAssessment[] {
  const seen = new Set<string>();
  const result: DjangoViewSecurityAssessment[] = [];
  for (const assessment of assessments) {
    const key = `${assessment.file}:${assessment.line}:${assessment.symbol_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(assessment);
  }
  return result;
}

// Symbol reads below never touch `source`: an assessment is built from decorators and bases only.
// Each is a keyed lookup (by id, or by file + name) — never the whole index.

async function findParentSymbol(repo: string, symbol: CodeSymbol): Promise<CodeSymbol | undefined> {
  if (!symbol.parent) return undefined;
  const [parent] = await findRepoSymbols(
    repo,
    { ids: [symbol.parent], withSource: false, limit: 1 },
    { skipFreshness: true },
  );
  return parent;
}

async function resolveSymbolsFromPath(repo: string, path: string): Promise<CodeSymbol[]> {
  const trace = await traceRoute(repo, path);
  if (!trace || typeof trace !== "object" || !("handlers" in trace)) return [];

  const handlers = (trace as { handlers: Array<{ framework?: string; symbol: { file: string; name: string; start_line: number } }> }).handlers;
  const resolved: Array<CodeSymbol | undefined> = [];
  for (const handler of handlers.filter((h) => h.framework === "django")) {
    const sameName = await findRepoSymbols(
      repo,
      { file: handler.symbol.file, name: handler.symbol.name, withSource: false },
      { skipFreshness: true },
    );
    resolved.push(sameName.find((symbol) => symbol.start_line === handler.symbol.start_line));
  }
  return resolved.filter((symbol): symbol is CodeSymbol => symbol !== undefined);
}

export async function effectiveDjangoViewSecurity(
  repo: string,
  options: {
    path?: string;
    symbol_name?: string;
    file_pattern?: string;
    settings_file?: string;
  },
): Promise<DjangoViewSecurityResult> {
  const index = await getIndexSummary(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);
  if (!options.path && !options.symbol_name) {
    throw new Error("Provide either path or symbol_name.");
  }

  const settingsFiles = getSettingsFiles(index, options.settings_file);
  const middleware = await collectMiddleware(index, settingsFiles);

  let symbols: CodeSymbol[] = [];
  if (options.path) {
    symbols = await resolveSymbolsFromPath(index.repo, options.path);
  } else if (options.symbol_name) {
    const named = await findRepoSymbols(
      repo,
      { name: options.symbol_name, withSource: false },
      { skipFreshness: true },
    );
    symbols = named.filter((symbol) =>
      symbol.file.endsWith(".py")
      && (symbol.kind === "function" || symbol.kind === "class" || symbol.kind === "method")
      && (!options.file_pattern || symbol.file.includes(options.file_pattern))
    );
  }

  const assessed: ReturnType<typeof buildAssessment>[] = [];
  for (const symbol of symbols) {
    assessed.push(buildAssessment(symbol, await findParentSymbol(repo, symbol), middleware, options.path));
  }
  const assessments = dedupeAssessments(assessed);

  return {
    assessments,
    settings_files: settingsFiles,
    middleware,
  };
}

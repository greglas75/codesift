import type { CodeIndex } from "../../types.js";
import { scanActionCallers } from "./callers.js";
import { parseActionsFile } from "./parser.js";
import type {
  ActionCode,
  ActionDescriptor,
  ActionsAuditIssue,
  ActionsAuditResult,
  ActionsSeverity,
  CallerScanResult,
  ExtractedAction,
} from "./types.js";
import { ACTION_CODES } from "./types.js";

export const ALL_ACTION_CODES = [...ACTION_CODES];

const SCORE_D_MIN_ERRORS = 3;
const SCORE_C_MIN_ERRORS = 1;
const SCORE_C_MIN_WARNINGS = 6;
const SCORE_B_MIN_WARNINGS = 3;

function issue(
  code: ActionCode,
  severity: ActionsAuditIssue["severity"],
  message: string,
  file: string,
  line: number,
  fix: string,
  action?: string,
): ActionsAuditIssue {
  const auditIssue: ActionsAuditIssue = { code, severity, message, file, line, fix };
  if (action) auditIssue.action = action;
  return auditIssue;
}

function computeScore(issues: ActionsAuditIssue[]): "A" | "B" | "C" | "D" {
  const errors = issues.filter(({ severity }) => severity === "error").length;
  const warnings = issues.filter(({ severity }) => severity === "warning").length;
  if (errors >= SCORE_D_MIN_ERRORS) return "D";
  if (errors >= SCORE_C_MIN_ERRORS || warnings >= SCORE_C_MIN_WARNINGS) return "C";
  if (warnings >= SCORE_B_MIN_WARNINGS) return "B";
  return "A";
}

function collectDefinitionIssues(
  actionsFile: string,
  actions: ExtractedAction[],
): ActionsAuditIssue[] {
  return actions.flatMap((action) => {
    const issues: ActionsAuditIssue[] = [];
    if (action.handler_missing_return) issues.push(issue(
      "AA01", "error",
      `Action "${action.name}" handler never returns a value — callers will receive undefined`,
      actionsFile, action.line,
      "Return the handler result explicitly (e.g. `return { ok: true }`)", action.name,
    ));
    if (action.refine_on_top_level) issues.push(issue(
      "AA02", "error",
      `Action "${action.name}" input uses .refine() on top-level z.object() — Astro issue #11641 makes this silently fail`,
      actionsFile, action.refine_line ?? action.line,
      "Move .refine() inside a nested z.object() field, or validate inside the handler", action.name,
    ));
    if (action.has_passthrough) issues.push(issue(
      "AA03", "warning",
      `Action "${action.name}" uses .passthrough() — Astro strips extra fields regardless (issue #11693)`,
      actionsFile, action.passthrough_line ?? action.line,
      "Declare every expected field in the schema explicitly — .passthrough() is ignored by Astro Actions",
      action.name,
    ));
    return issues;
  });
}

function collectCallerIssues(scan: CallerScanResult): ActionsAuditIssue[] {
  return scan.reportableCalls.map((call) => call.is_server_side
    ? issue(
      "AA05", "warning",
      `Action "${call.action}" called from .astro frontmatter — prefer Astro.callAction() or a direct import`,
      call.file, call.line,
      `Use Astro.callAction(actions.${call.action}, input) in server code`, call.action,
    )
    : issue(
      "AA06", "error", `Client-side code calls unknown action "${call.action}"`,
      call.file, call.line,
      `Define "${call.action}" in src/actions/index.ts or remove the call`, call.action,
    ));
}

function collectFileIssues(
  actions: ExtractedAction[],
  scan: CallerScanResult,
): ActionsAuditIssue[] {
  return actions.flatMap((action) => {
    if (!action.has_file_field) return [];
    return (scan.callersByAction.get(action.name) ?? []).flatMap((caller) => {
      if (caller.formTag === null
        || /enctype\s*=\s*["']multipart\/form-data["']/i.test(caller.formTag)) return [];
      return [issue(
        "AA04", "error",
        `Action "${action.name}" expects a File but caller form lacks enctype="multipart/form-data"`,
        caller.file, caller.line,
        "Add enctype=\"multipart/form-data\" to the <form> tag, or switch the schema off z.instanceof(File)",
        action.name,
      )];
    });
  });
}

function filterIssues(issues: ActionsAuditIssue[], severity?: ActionsSeverity): ActionsAuditIssue[] {
  if (severity === "errors") return issues.filter(({ severity: level }) => level === "error");
  if (severity === "warnings") return issues.filter(({ severity: level }) => level !== "info");
  return issues;
}

function toDescriptor(action: ExtractedAction): ActionDescriptor {
  const descriptor: ActionDescriptor = {
    name: action.name,
    file: action.file,
    line: action.line,
    has_input_schema: action.has_input_schema,
    input_fields: action.input_fields,
  };
  if (action.accept !== undefined) descriptor.accept = action.accept;
  return descriptor;
}

export async function auditAstroActionsFromIndex(
  index: CodeIndex,
  severity?: ActionsSeverity,
): Promise<ActionsAuditResult> {
  const parsed = await parseActionsFile(index.root);
  if (!parsed) {
    return {
      actions: [], issues: [], anti_patterns_checked: ALL_ACTION_CODES,
      summary: { total_actions: 0, total_issues: 0, score: "A" },
    };
  }

  const actionNames = new Set(parsed.actions.map(({ name }) => name));
  const callerScan = scanActionCallers(index, actionNames);
  const allIssues = [
    ...collectDefinitionIssues(parsed.file, parsed.actions),
    ...collectCallerIssues(callerScan),
    ...collectFileIssues(parsed.actions, callerScan),
  ];
  const issues = filterIssues(allIssues, severity);
  const actions = parsed.actions.map(toDescriptor);
  return {
    actions,
    issues,
    anti_patterns_checked: ALL_ACTION_CODES,
    summary: {
      total_actions: actions.length,
      total_issues: issues.length,
      score: computeScore(issues),
    },
  };
}

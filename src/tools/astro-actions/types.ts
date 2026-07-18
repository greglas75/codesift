export const ACTION_CODES = ["AA01", "AA02", "AA03", "AA04", "AA05", "AA06"] as const;
export type ActionCode = (typeof ACTION_CODES)[number];

export interface ActionDescriptor {
  name: string;
  file: string;
  line: number;
  accept?: "json" | "form";
  has_input_schema: boolean;
  input_fields: string[];
}

export interface ActionsAuditIssue {
  code: ActionCode;
  severity: "error" | "warning" | "info";
  message: string;
  file: string;
  line: number;
  action?: string;
  fix: string;
}

export interface ActionsAuditResult {
  actions: ActionDescriptor[];
  issues: ActionsAuditIssue[];
  anti_patterns_checked: string[];
  summary: {
    total_actions: number;
    total_issues: number;
    score: "A" | "B" | "C" | "D";
  };
}

export interface ExtractedAction extends ActionDescriptor {
  handler_missing_return: boolean;
  refine_on_top_level: boolean;
  refine_line?: number;
  has_passthrough: boolean;
  passthrough_line?: number;
  has_file_field: boolean;
}

export interface ActionsFileExtraction {
  file: string;
  actions: ExtractedAction[];
}

export interface ActionCall {
  file: string;
  line: number;
  action: string;
  is_server_side: boolean;
}

export interface CallerInfo {
  file: string;
  line: number;
  formTag: string | null;
}

export interface CallerScanResult {
  callersByAction: Map<string, CallerInfo[]>;
  reportableCalls: ActionCall[];
}

export type ActionsSeverity = "all" | "warnings" | "errors";

import { basename } from "node:path";
import { scan } from "@sanity-labs/secret-scan";
import { isTestFile } from "../utils/test-file.js";
import type { CodeSymbol } from "../types.js";
import type { SecretContext, SecretFinding, SecretSeverity } from "./secret-scan-types.js";

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);
const PLACEHOLDER_NAMES = new Set([
  "placeholder", "example", "sample", "dummy", "test", "mock",
  "fake", "stub", "default", "template",
]);

export const SEVERITY_MAP: Record<string, SecretSeverity> = {
  aws: "critical", "aws-access_keys": "critical", "aws-secret": "critical",
  gcp: "critical", "gcp-api-key": "critical", azure: "critical",
  openai: "high", anthropic: "high", stripe: "high", "stripe-secret": "high",
  twilio: "high", sendgrid: "high", github: "high", "github-v2": "high",
  "github-pat": "high", gitlab: "high", slack: "high", "slack-token": "high",
  "generic-api-key": "medium", "private-key": "medium",
  "database-connection-string": "medium", jwt: "medium",
};

export function maskSecret(secret: string): string {
  if (secret.length < 8) return "****";
  return secret.slice(0, 4) + "***" + secret.slice(-4);
}

export function isDocFile(filePath: string): boolean {
  return DOC_EXTENSIONS.has(filePath.slice(filePath.lastIndexOf(".")));
}

export function classifyContext(filePath: string): SecretContext["type"] {
  if (isTestFile(filePath)) return "test";
  if (isDocFile(filePath)) return "doc";
  const base = basename(filePath);
  if (base.endsWith(".env") || base.startsWith(".env") || base.endsWith(".yaml")
    || base.endsWith(".yml") || base.endsWith(".toml") || base.endsWith(".ini")
    || base.endsWith(".cfg") || (base.endsWith(".json") && !base.endsWith("package.json"))) {
    return "config";
  }
  return "production";
}

export function getSeverity(rule: string): SecretSeverity {
  return SEVERITY_MAP[rule] ?? "medium";
}

export function isAllowlisted(lines: string[], lineNumber: number): boolean {
  const lineIdx = lineNumber - 1;
  return [lineIdx, lineIdx - 1].some(
    (index) => index >= 0 && index < lines.length && lines[index]!.includes("codesift:allow-secret"),
  );
}

export function offsetToLine(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

export function enrichWithSymbolContext(
  finding: SecretFinding,
  symbols: CodeSymbol[],
): SecretFinding {
  const symbol = symbols.find((candidate) => candidate.file === finding.file
    && finding.line >= candidate.start_line && finding.line <= candidate.end_line);
  if (!symbol) return finding;
  const enriched: SecretFinding = {
    ...finding,
    context: { ...finding.context, symbol_name: symbol.name, symbol_kind: symbol.kind },
  };
  const name = symbol.name.toLowerCase();
  if ([...PLACEHOLDER_NAMES].some((placeholder) => name.includes(placeholder))) {
    enriched.confidence = "low";
  }
  return enriched;
}

export function collectSecretFindings(
  content: string,
  relPath: string,
  symbols: CodeSymbol[],
): SecretFinding[] {
  const lines = content.split("\n");
  const contextType = classifyContext(relPath);
  return scan(content).flatMap((secret) => {
    const line = offsetToLine(content, secret.start);
    if (isAllowlisted(lines, line)) return [];
    const confidence = contextType === "test" || contextType === "doc"
      ? "low" as const
      : secret.confidence;
    return [enrichWithSymbolContext({
      rule: secret.rule, label: secret.label, masked_secret: maskSecret(secret.text),
      confidence, severity: getSeverity(secret.rule), file: relPath, line,
      context: { type: contextType },
    }, symbols)];
  });
}

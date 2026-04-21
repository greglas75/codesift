import { createHash } from "node:crypto";

export interface SentinelBlock {
  prefix: "auto" | "manual";
  kind: string;
  content: string;
  startLine: number;
  endLine: number;
  hash: string;
}

export class SentinelIntegrityError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "SentinelIntegrityError";
    this.line = line;
  }
}

const BEGIN_RE = /^<!--\s+(auto|manual):begin\s+([^\s]+)\s+-->\s*$/;
const END_RE = /^<!--\s+(auto|manual):end\s+([^\s]+)\s+-->\s*$/;
const SOURCE_COMMITS_RE = /^<!--\s*source_commits:.*-->\s*$/;
const ENTRY_DATE_RE = /^entry:(\d{4})-(\d{2})-(\d{2})$/;
const VALID_AUTO_KINDS = new Set(["meta", "phase-summary"]);
const VALID_MANUAL_KINDS = new Set(["migrated-overview"]);

type OpenBlock = {
  prefix: "auto" | "manual";
  kind: string;
  startLine: number;
  bodyLines: string[];
};

function isValidEntryKind(kind: string): boolean {
  const m = ENTRY_DATE_RE.exec(kind);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function isKnownKind(prefix: "auto" | "manual", kind: string): boolean {
  if (prefix === "manual") return VALID_MANUAL_KINDS.has(kind);
  return VALID_AUTO_KINDS.has(kind) || kind.startsWith("entry:");
}

export function computeBlockHash(blockContent: string): string {
  const lf = blockContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const stripped = lf
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n");
  return createHash("sha256").update(stripped, "utf8").digest("hex");
}

export function parseSentinelBlocks(content: string): SentinelBlock[] {
  const lines = content.split("\n");
  const blocks: SentinelBlock[] = [];
  let open: OpenBlock | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const beginMatch = BEGIN_RE.exec(line);
    const endMatch = END_RE.exec(line);

    if (beginMatch) {
      const prefix = beginMatch[1] as "auto" | "manual";
      const kind = beginMatch[2]!;
      if (!isKnownKind(prefix, kind)) {
        if (open) open.bodyLines.push(line);
        continue;
      }
      if (prefix === "auto" && kind.startsWith("entry:") && !isValidEntryKind(kind)) {
        throw new SentinelIntegrityError(
          `invalid entry date in auto:begin ${kind}`,
          lineNo
        );
      }
      if (open) {
        throw new SentinelIntegrityError(
          `nested ${prefix}:begin ${kind} inside open ${open.prefix}:begin ${open.kind}`,
          lineNo
        );
      }
      open = { prefix, kind, startLine: lineNo, bodyLines: [] };
      continue;
    }

    if (endMatch) {
      const prefix = endMatch[1] as "auto" | "manual";
      const kind = endMatch[2]!;
      if (!isKnownKind(prefix, kind)) {
        if (open) open.bodyLines.push(line);
        continue;
      }
      if (!open) {
        throw new SentinelIntegrityError(
          `stray ${prefix}:end ${kind} with no matching begin`,
          lineNo
        );
      }
      if (open.prefix !== prefix || open.kind !== kind) {
        throw new SentinelIntegrityError(
          `mismatch: ${prefix}:end ${kind} does not match open ${open.prefix}:begin ${open.kind}`,
          lineNo
        );
      }
      const bodyContent = open.bodyLines.join("\n");
      if (open.prefix === "auto" && open.kind.startsWith("entry:")) {
        const nonEmpty = open.bodyLines.filter((l) => l.trim().length > 0);
        const last = nonEmpty[nonEmpty.length - 1];
        if (!last || !SOURCE_COMMITS_RE.test(last)) {
          throw new SentinelIntegrityError(
            `entry ${open.kind} missing required source_commits footer`,
            open.startLine
          );
        }
      }
      blocks.push({
        prefix: open.prefix,
        kind: open.kind,
        content: bodyContent,
        startLine: open.startLine,
        endLine: lineNo,
        hash: computeBlockHash(bodyContent),
      });
      open = null;
      continue;
    }

    if (open) open.bodyLines.push(line);
  }

  if (open) {
    throw new SentinelIntegrityError(
      `unclosed ${open.prefix}:begin ${open.kind} reached EOF`,
      open.startLine
    );
  }
  return blocks;
}

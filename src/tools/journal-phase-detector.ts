import type { GitCommit } from "./journal-git-client.js";

export interface PhaseOverride {
  date: string;  // ISO date "YYYY-MM-DD"
  slug: string;
  title: string;
}

export interface PhasePlan {
  slug: string;
  title: string;
  startDate: string;
  endDate: string;
  commits: GitCommit[];
  source: "auto" | "manual";
}

export class PhaseOverridesParseError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "PhaseOverridesParseError";
    this.line = line;
  }
}

// Helpers
const TAG_REF_RE = /^tag:\s*v?\d/;
const SCOPE_RE = /^(?:feat|refactor|docs|fix)\(([^)]+)\)/;
const MS_PER_DAY = 86_400_000;

const isoDay = (s: string): string => s.slice(0, 10);
const gapDays = (a: string, b: string): number =>
  (Date.parse(isoDay(b)) - Date.parse(isoDay(a))) / MS_PER_DAY;
const slugify = (t: string): string =>
  t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function titleFrom(commits: GitCommit[]): string {
  for (const c of commits) { const m = SCOPE_RE.exec(c.subject); if (m?.[1]) return m[1]; }
  return "unclassified";
}
function makePlan(commits: GitCommit[], source: "auto" | "manual", slug?: string, title?: string): PhasePlan {
  const t = title ?? titleFrom(commits);
  const days = commits.map((c) => isoDay(c.date)).sort();
  return { slug: slug ?? slugify(t), title: t, startDate: days[0] ?? "", endDate: days[days.length - 1] ?? "", commits, source };
}
function dedupSlugs(plans: PhasePlan[]): PhasePlan[] {
  const seen = new Map<string, number>();
  return plans.map((p) => { const n = seen.get(p.slug) ?? 0; seen.set(p.slug, n + 1); return n === 0 ? p : { ...p, slug: `${p.slug}-${n + 1}` }; });
}

// detectPhases

export function detectPhases(commits: GitCommit[], overrides?: PhaseOverride[]): PhasePlan[] {
  if (commits.length === 0) return [];

  const sorted = [...commits].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const ovMap = new Map<string, PhaseOverride>();
  for (const ov of overrides ?? []) ovMap.set(ov.date, ov);

  const groups: GitCommit[][] = [];
  let cur: GitCommit[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    const prev = sorted[i - 1];
    const day = isoDay(c.date);

    // Boundary BEFORE this commit: override date or >2-day gap
    if (cur.length > 0 && (ovMap.has(day) || (prev !== undefined && gapDays(prev.date, c.date) > 2))) {
      groups.push(cur);
      cur = [];
    }

    cur.push(c);

    // Boundary AFTER this commit: merge or tag (next commit starts new group)
    const isMerge = c.parentShas.length >= 2;
    const isTagged = c.refs.some((r) => TAG_REF_RE.test(r));
    if ((isMerge || isTagged) && i < sorted.length - 1) {
      groups.push(cur);
      cur = [];
    }
  }

  if (cur.length > 0) groups.push(cur);

  const plans = groups.map((grp) => {
    for (const c of grp) {
      const ov = ovMap.get(isoDay(c.date));
      if (ov !== undefined) return makePlan(grp, "manual", ov.slug, ov.title);
    }
    return makePlan(grp, "auto");
  });

  return dedupSlugs(plans);
}

// parsePhaseOverridesYAML — inline parser (no yaml dep required)

export function parsePhaseOverridesYAML(raw: string): PhaseOverride[] {
  const lines = raw.split("\n");
  const result: PhaseOverride[] = [];
  let cur: Partial<PhaseOverride> | null = null;

  const flush = (lineNum: number): void => {
    if (cur === null) return;
    if (!cur.date || !cur.slug || !cur.title) {
      throw new PhaseOverridesParseError("incomplete override entry", lineNum);
    }
    result.push(cur as PhaseOverride);
    cur = null;
  };

  const setKV = (kv: string, lineNum: number): void => {
    const idx = kv.indexOf(":");
    if (idx === -1) throw new PhaseOverridesParseError("expected 'key: value'", lineNum);
    const key = kv.slice(0, idx).trim();
    const val = kv.slice(idx + 1).trim();
    if (!key) throw new PhaseOverridesParseError("invalid key format", lineNum);
    (cur as Record<string, string>)[key] = val;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i]!;
    if (line.trim() === "") continue;

    if (line.startsWith("- ")) {
      flush(lineNum);
      cur = {};
      setKV(line.slice(2), lineNum);
    } else if (line.startsWith("  ")) {
      if (cur === null) throw new PhaseOverridesParseError("unexpected indented line", lineNum);
      const trimmed = line.trimStart();
      if (!/^[a-zA-Z]/.test(trimmed)) {
        throw new PhaseOverridesParseError("invalid key format", lineNum);
      }
      setKV(trimmed, lineNum);
    } else {
      throw new PhaseOverridesParseError("unexpected line format", lineNum);
    }
  }

  flush(lines.length);
  return result;
}

import { escMd } from "./wiki-escape.js";
import type { SurpriseScore, CommunityInfo } from "./wiki-surprise.js";

export type { CommunityInfo };

export interface HubSymbol {
  name: string;
  file: string;
  role: string;
  callers: number;
  callees: number;
}

export interface FileHotspot {
  file: string;
  commits: number;
  hotspot_score: number;
}

export interface FrameworkInfo {
  name: string;
  details: string;
}

export interface CommunityPageData {
  community: CommunityInfo;
  cohesion: number;
  internal_edges: number;
  external_edges: number;
  hotspots: FileHotspot[];
  hub_symbols: HubSymbol[];
}

const MAX_FILES_DISPLAY = 15;
const SUMMARY_CHAR_BUDGET = 1600; // ~400 tokens at 4 chars/token

export function generateCommunityPage(data: CommunityPageData): string {
  const { community, cohesion, internal_edges, external_edges, hotspots, hub_symbols } = data;
  const lines: string[] = [];

  lines.push(`# ${escMd(community.name)}`);
  lines.push("");
  lines.push(
    `**Cohesion:** ${(cohesion * 100).toFixed(0)}%  |  ` +
      `**Internal edges:** ${internal_edges}  |  ` +
      `**External edges:** ${external_edges}  |  ` +
      `**Files:** ${community.size}`,
  );
  lines.push("", "## Files", "");
  const displayFiles = community.files.slice(0, MAX_FILES_DISPLAY);
  for (const f of displayFiles) lines.push(`- ${escMd(f)}`);
  if (community.files.length > MAX_FILES_DISPLAY) {
    const extra = community.files.length - MAX_FILES_DISPLAY;
    lines.push(`- *+${extra} more files (use \`codesift wiki-generate --focus\` to see all)*`);
  }
  lines.push("");
  if (hub_symbols.length > 0) {
    lines.push("## Hub Symbols", "", "| Symbol | Role | Callers | Callees |",
      "| ------ | ---- | ------: | ------: |");
    for (const h of hub_symbols) {
      lines.push(`| ${escMd(h.name)} | ${escMd(h.role)} | ${h.callers} | ${h.callees} |`);
    }
    lines.push("");
  }
  if (hotspots.length > 0) {
    lines.push("## Hotspots", "", "| File | Commits | Score |", "| ---- | ------: | ----: |");
    for (const h of hotspots) {
      lines.push(`| ${escMd(h.file)} | ${h.commits} | ${h.hotspot_score.toFixed(2)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function generateCommunitySummary(data: CommunityPageData): string {
  const { community, cohesion, hub_symbols } = data;
  const lines: string[] = [
    `**${escMd(community.name)}**`,
    `Cohesion: ${(cohesion * 100).toFixed(0)}% | Files: ${community.size}`,
  ];
  const topFiles = community.files.slice(0, 3);
  if (topFiles.length > 0) lines.push(`Top files: ${topFiles.map(escMd).join(", ")}`);
  const topHub = hub_symbols[0];
  if (topHub !== undefined) lines.push(`Top hub: ${escMd(topHub.name)} (${topHub.callers} callers)`);
  const result = lines.join("\n");
  return result.length <= SUMMARY_CHAR_BUDGET ? result : result.slice(0, SUMMARY_CHAR_BUDGET);
}

export function generateHubsPage(hubs: HubSymbol[]): string {
  const lines: string[] = [
    "# Hub Symbols", "",
    "High-centrality symbols that act as architectural connectors.", "",
  ];
  if (hubs.length === 0) {
    lines.push("No hub symbols detected.");
  } else {
    lines.push("| Symbol | File | Role | Callers | Callees |",
      "| ------ | ---- | ---- | ------: | ------: |");
    for (const h of hubs) {
      lines.push(
        `| ${escMd(h.name)} | ${escMd(h.file)} | ${escMd(h.role)} | ${h.callers} | ${h.callees} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function generateSurprisePage(surprises: SurpriseScore[]): string {
  const lines: string[] = [
    "# Surprise Connections", "",
    "Cross-community boundaries with higher coupling than expected (structural + temporal).", "",
  ];
  if (surprises.length === 0) {
    lines.push("No surprise connections detected.");
  } else {
    lines.push(
      "| Community A | Community B | Score | Edges | Example Files |",
      "| ----------- | ----------- | ----: | ----: | ------------- |",
    );
    for (const s of surprises) {
      const ex = `${escMd(s.example_files[0])} ↔ ${escMd(s.example_files[1])}`;
      lines.push(
        `| ${escMd(s.community_a)} | ${escMd(s.community_b)} | ${s.combined_score.toFixed(2)} | ${s.edge_count} | ${ex} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function generateHotspotsPage(hotspots: FileHotspot[]): string {
  const lines: string[] = [
    "# Hotspot Files", "",
    "Files ranked by churn × complexity (commit frequency × size).", "",
  ];
  if (hotspots.length === 0) {
    lines.push("No hotspot data available.");
  } else {
    lines.push("| File | Commits | Score |", "| ---- | ------: | ----: |");
    for (const h of hotspots) {
      lines.push(`| ${escMd(h.file)} | ${h.commits} | ${h.hotspot_score.toFixed(2)} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function generateFrameworkPage(framework: FrameworkInfo | null): string {
  if (framework === null) return "";
  return [`# Framework: ${escMd(framework.name)}`, "", escMd(framework.details), ""].join("\n");
}

export function generateIndexPage(
  pages: Array<{ slug: string; title: string; type: string }>,
): string {
  const lines: string[] = [
    "# Wiki Index", "",
    "Auto-generated codebase wiki. Use the links below to navigate.", "",
  ];
  const byType = new Map<string, typeof pages>();
  for (const page of pages) {
    const group = byType.get(page.type) ?? [];
    group.push(page);
    byType.set(page.type, group);
  }
  for (const [type, group] of byType) {
    lines.push(`## ${escMd(type)}`, "");
    for (const page of group) lines.push(`- [[${page.slug}]] — ${escMd(page.title)}`);
    lines.push("");
  }
  return lines.join("\n");
}

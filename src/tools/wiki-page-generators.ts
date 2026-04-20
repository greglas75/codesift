import { escMd } from "./wiki-escape.js";
import type { SurpriseScore, CommunityInfo } from "./wiki-surprise.js";
import type { ModuleMetadata, ProjectOverview } from "./wiki-manifest.js";

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

/**
 * Generate a community markdown page. When `module` is provided (v2 path),
 * the page leads with Overview / Key Exports / Dependencies sections populated
 * from structured metadata. When `module` is undefined (v1 rollback path),
 * falls back to the legacy generic boilerplate.
 */
export function generateCommunityPage(
  data: CommunityPageData,
  module?: ModuleMetadata,
): string {
  const { community, cohesion, internal_edges, external_edges, hotspots, hub_symbols } = data;
  const lines: string[] = [];

  lines.push(`# ${escMd(community.name)}`);
  lines.push("");

  if (module) {
    lines.push("## Overview", "", escMd(module.description), "");
    if (module.key_exports.length > 0) {
      lines.push("## Key Exports", "");
      if (module.key_exports_approximate) {
        lines.push("> *Approximate list — regenerated after a full reindex will be more precise.*", "");
      }
      lines.push("| Name | Kind | File | Signature |", "| ---- | ---- | ---- | --------- |");
      for (const k of module.key_exports) {
        lines.push(
          `| \`${escMd(k.name)}\` | ${escMd(k.kind)} | \`${escMd(k.file)}\` | ${k.signature ? escMd(k.signature) : "—"} |`,
        );
      }
      lines.push("");
    }
  } else {
    lines.push("> A **community** is a group of files that are more tightly connected to each other (via imports) than to the rest of the codebase. Detected automatically by the Louvain algorithm on the import graph.");
    lines.push("");
  }

  lines.push(
    `**Cohesion:** ${(cohesion * 100).toFixed(0)}% *(higher = files in this module import each other more than outsiders)*  |  ` +
      `**Internal edges:** ${internal_edges} *(imports within this module)*  |  ` +
      `**External edges:** ${external_edges} *(imports crossing module boundary)*  |  ` +
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

  if (module && (module.depends_on.length > 0 || module.depended_by.length > 0)) {
    lines.push("## Dependencies", "");
    if (module.depends_on.length > 0) {
      lines.push(`- **Depends on:** ${module.depends_on.map((s) => `[[${s}]]`).join(", ")}`);
    }
    if (module.depended_by.length > 0) {
      lines.push(`- **Depended by:** ${module.depended_by.map((s) => `[[${s}]]`).join(", ")}`);
    }
    lines.push("");
  }

  if (hub_symbols.length > 0 && (!module || module.role !== "micro-module")) {
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

/**
 * Generate the 2500-char `.summary.md` injected by the PreToolUse hook.
 * When `module` is provided, the summary leads with purpose + exports + deps;
 * otherwise falls back to the legacy 4-line format.
 */
export function generateCommunitySummary(
  data: CommunityPageData,
  module?: ModuleMetadata,
): string {
  const { community, cohesion, hub_symbols } = data;
  const lines: string[] = [];
  if (module) {
    lines.push(`**${escMd(community.name)}** — ${escMd(module.role)}`);
    lines.push(`Purpose: ${escMd(module.description)}`);
    lines.push(`Cohesion: ${(cohesion * 100).toFixed(0)}% | Files: ${community.size}`);
    if (module.key_exports.length > 0) {
      const names = module.key_exports.slice(0, 5).map((k) => `${k.name} (${k.kind})`).join(", ");
      lines.push(`Key exports: ${names}${module.key_exports_approximate ? " [approximate]" : ""}`);
    }
    if (module.depends_on.length > 0) {
      lines.push(`Depends on: ${module.depends_on.slice(0, 5).join(", ")}`);
    }
    if (module.has_hotspot) {
      lines.push(`⚠ Contains hotspot file — high churn + complexity.`);
    }
  } else {
    lines.push(`**${escMd(community.name)}**`);
    lines.push(`Cohesion: ${(cohesion * 100).toFixed(0)}% | Files: ${community.size}`);
    const topFiles = community.files.slice(0, 3);
    if (topFiles.length > 0) lines.push(`Top files: ${topFiles.map(escMd).join(", ")}`);
    const topHub = hub_symbols[0];
    if (topHub !== undefined) lines.push(`Top hub: ${escMd(topHub.name)} (${topHub.callers} callers)`);
  }
  const result = lines.join("\n");
  return result.length <= SUMMARY_CHAR_BUDGET ? result : result.slice(0, SUMMARY_CHAR_BUDGET);
}

/** Project-overview landing page (new in v2). */
export function generateOverviewPage(
  project: ProjectOverview,
  modules: ModuleMetadata[],
): string {
  const lines: string[] = [
    `# ${escMd(project.name)}`,
    "",
    `> Project overview — auto-generated from source.`,
    "",
    "## Stack",
    "",
    `- **Language:** ${escMd(project.stack.language)}${project.stack.language_version ? ` ${escMd(project.stack.language_version)}` : ""}`,
  ];
  if (project.stack.framework) {
    lines.push(`- **Framework:** ${escMd(project.stack.framework)}${project.stack.framework_version ? ` ${escMd(project.stack.framework_version)}` : ""}`);
  }
  if (project.stack.test_runner) lines.push(`- **Test runner:** ${escMd(project.stack.test_runner)}`);
  if (project.stack.package_manager) lines.push(`- **Package manager:** ${escMd(project.stack.package_manager)}`);
  if (project.stack.build_tool) lines.push(`- **Build tool:** ${escMd(project.stack.build_tool)}`);
  lines.push("");

  const scriptEntries = Object.entries(project.scripts);
  if (scriptEntries.length > 0) {
    lines.push("## Scripts", "", "| Script | Command |", "| ------ | ------- |");
    for (const [name, cmd] of scriptEntries.slice(0, 10)) {
      lines.push(`| \`${escMd(name)}\` | \`${escMd(cmd)}\` |`);
    }
    lines.push("");
  }

  if (project.entry_points.length > 0) {
    lines.push("## Entry Points", "");
    for (const ep of project.entry_points.slice(0, 10)) {
      lines.push(`- \`${escMd(ep)}\``);
    }
    lines.push("");
  }

  if (project.dependencies.key.length > 0) {
    lines.push("## Key Dependencies", "", `Total: ${project.dependencies.prod_total} prod, ${project.dependencies.dev_total} dev.`, "", "| Package | Version | Kind |", "| ------- | ------- | ---- |");
    for (const d of project.dependencies.key.slice(0, 15)) {
      lines.push(`| \`${escMd(d.name)}\` | ${escMd(d.version || "—")} | ${escMd(d.kind)} |`);
    }
    lines.push("");
  }

  if (project.known_gotchas.length > 0) {
    lines.push("## Known Gotchas", "");
    for (const g of project.known_gotchas.slice(0, 10)) {
      lines.push(`- **[${escMd(g.severity)}]** ${escMd(g.gotcha)}`);
    }
    lines.push("");
  }

  if (modules.length > 0) {
    lines.push("## Modules", "");
    for (const m of modules.slice(0, 20)) {
      lines.push(`- [[${m.slug}]] — *${escMd(m.role)}* · ${escMd(m.description)}`);
    }
    lines.push("");
  }

  lines.push("## Stats", "",
    `- Files: ${project.stats.total_files}`,
    project.stats.total_commits !== null ? `- Commits: ${project.stats.total_commits}` : "- Commits: *(shallow clone or no git history)*",
    project.stats.contributors !== null ? `- Contributors: ${project.stats.contributors}` : "- Contributors: *(shallow clone)*",
    "",
  );
  return lines.join("\n");
}

/** Architecture narrative page — module dependencies + roles. */
export function generateArchitecturePage(modules: ModuleMetadata[]): string {
  const lines: string[] = ["# Architecture", ""];
  if (modules.length === 0) {
    lines.push("*No modules detected.*", "");
    return lines.join("\n");
  }
  lines.push("> Module roles and dependency structure derived from the import graph.", "");
  lines.push("## Roles", "", "| Module | Role | Files | Cohesion | Depends on |", "| ------ | ---- | ----: | -------: | ---------- |");
  for (const m of modules) {
    const deps = m.depends_on.length === 0 ? "—" : m.depends_on.map((s) => `[[${s}]]`).join(", ");
    lines.push(`| [[${m.slug}]] | ${escMd(m.role)} | ${m.files} | ${(m.cohesion * 100).toFixed(0)}% | ${deps} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function generateHubsPage(hubs: HubSymbol[]): string {
  const lines: string[] = [
    "# Hub Symbols", "",
    "> **Hub symbols** are functions or classes with high fan-in — many other parts of the codebase depend on them. Changes to a hub symbol have a large blast radius. They are the load-bearing pillars of the architecture.", "",
    "- **entry**: top-level entry points (CLI handlers, route controllers, main functions)",
    "- **core**: heavily imported by other modules — the backbone of the system",
    "- **utility**: widely used helpers (formatters, validators, converters)",
    "- **leaf**: end-of-chain code with no dependents (tests, scripts)",
    "",
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
    "> **Surprises** are cross-module connections that are stronger than expected. If two modules have more imports between them than a random graph would predict, it suggests hidden coupling worth investigating. A high score means the connection is disproportionately strong — these modules may belong together, or there may be an abstraction missing.", "",
    "**Score** = 0.6 × structural (import density ratio) + 0.4 × temporal (co-change frequency). Higher = more surprising.", "",
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
    "> **Hotspots** are files that change frequently AND are large/complex. These are the highest-risk files in your codebase — statistically most likely to contain bugs, hardest to review, and most expensive to maintain. Consider refactoring or splitting hotspot files to reduce risk.", "",
    "**Score** = commit count × symbol count. Higher = more volatile and complex.", "",
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
  project?: ProjectOverview,
): string {
  const heading = project ? `# ${escMd(project.name)} — Wiki` : "# Wiki Index";
  const subtitle = project
    ? `> **Stack:** ${escMd(project.stack.language)}${project.stack.framework ? ` · ${escMd(project.stack.framework)}` : ""} — ${project.stats.total_files} files.`
    : "> This wiki was auto-generated from your codebase's structure using static analysis — no manual writing needed. It shows how your code is organized into modules (communities), which symbols are most critical (hubs), where hidden coupling exists (surprises), and which files are highest-risk (hotspots).";
  const lines: string[] = [
    heading, "",
    subtitle, "",
    "**How to read this wiki:**",
    "- **Overview** = project stack, scripts, entry points, key dependencies",
    "- **Communities** = groups of files that import each other heavily (Louvain)",
    "- **Hubs** = functions/classes that many other files depend on (fan-in)",
    "- **Surprises** = unexpected connections between modules",
    "- **Hotspots** = files with high churn + complexity",
    "",
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

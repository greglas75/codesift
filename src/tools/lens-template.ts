import { escHtml } from "./wiki-escape.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LensData {
  repo: string;
  communities: Array<{
    name: string;
    files: string[];
    cohesion: number;
    symbol_count: number;
  }>;
  hubs: Array<{
    name: string;
    file: string;
    role: string;
    callers: number;
    callees: number;
  }>;
  surprises: Array<{
    community_a: string;
    community_b: string;
    combined_score: number;
    edge_count: number;
    example_files: [string, string];
  }>;
  hotspots: Array<{
    file: string;
    hotspot_score: number;
    commits: number;
  }>;
  wiki_pages: Array<{
    slug: string;
    title: string;
    content: string;
  }>;
  generated_at: string;
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildOverviewSection(data: LensData): string {
  const safeRepo = escHtml(data.repo);
  const safeDate = escHtml(data.generated_at.slice(0, 10));
  return `
    <div id="tab-overview" class="tab-panel active">
      <h2>Overview</h2>
      <p><strong>${safeRepo}</strong> &mdash; generated ${safeDate}${data.degraded ? ' <span class="warn">(degraded)</span>' : ""}</p>
      <div class="metrics">
        <div class="metric"><b>${data.communities.length}</b>Communities</div>
        <div class="metric"><b>${data.hubs.length}</b>Hubs</div>
        <div class="metric"><b>${data.surprises.length}</b>Surprises</div>
        <div class="metric"><b>${data.hotspots.length}</b>Hotspots</div>
        <div class="metric"><b>${data.wiki_pages.length}</b>Wiki Pages</div>
      </div>
      ${buildHotspotsInOverview(data.hotspots)}
    </div>`;
}

function buildHotspotsInOverview(hotspots: LensData["hotspots"]): string {
  if (hotspots.length === 0) {
    return `<p class="empty">No hotspots detected.</p>`;
  }
  const rows = hotspots
    .slice(0, 10)
    .map(
      (h) =>
        `<tr><td>${escHtml(h.file)}</td><td>${(h.hotspot_score * 100).toFixed(0)}%</td><td>${h.commits}</td></tr>`,
    )
    .join("");
  return `
      <h3>Top Hotspots</h3>
      <table>
        <thead><tr><th>File</th><th>Score</th><th>Commits</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
}

function buildCommunitiesSection(data: LensData): string {
  const showChord = data.communities.length >= 2;
  const communityRows = data.communities
    .map((c) => {
      const pct = Math.round(c.cohesion * 100);
      return `
        <div class="community-card">
          <div class="community-header">
            <span class="community-name">${escHtml(c.name)}</span>
            <span class="community-stats">${c.files.length} files &middot; ${c.symbol_count} symbols</span>
          </div>
          <div class="cohesion-bar-bg"><div class="cohesion-bar" style="width:${pct}%"></div></div>
          <span class="cohesion-label">Cohesion ${pct}%</span>
        </div>`;
    })
    .join("");

  const chordOrNotice = showChord
    ? `<div id="chord" class="chord-container"></div>`
    : `<p class="low-mod-notice">low modularity &mdash; not enough communities for chord diagram (need &ge;2).</p>`;

  return `
    <div id="tab-communities" class="tab-panel">
      <h2>Communities</h2>
      ${chordOrNotice}
      ${communityRows}
    </div>`;
}

function buildHubsSection(data: LensData): string {
  if (data.hubs.length === 0) {
    return `<div id="tab-hubs" class="tab-panel"><h2>Hubs</h2><p class="empty">No hub symbols detected.</p></div>`;
  }
  const rows = data.hubs
    .map(
      (h) =>
        `<tr>
          <td>${escHtml(h.name)}</td>
          <td class="file-cell">${escHtml(h.file)}</td>
          <td><span class="badge">${escHtml(h.role)}</span></td>
          <td>${h.callers}</td>
          <td>${h.callees}</td>
        </tr>`,
    )
    .join("");
  return `
    <div id="tab-hubs" class="tab-panel">
      <h2>Hub Symbols</h2>
      <table>
        <thead><tr><th>Symbol</th><th>File</th><th>Role</th><th>Callers</th><th>Callees</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function buildSurprisesSection(data: LensData): string {
  if (data.surprises.length === 0) {
    return `<div id="tab-surprises" class="tab-panel"><h2>Surprises</h2><p class="empty">No surprise connections detected.</p></div>`;
  }
  const rows = data.surprises
    .map(
      (s) =>
        `<tr>
          <td>${escHtml(s.community_a)}</td>
          <td>${escHtml(s.community_b)}</td>
          <td>${(s.combined_score * 100).toFixed(0)}%</td>
          <td>${s.edge_count}</td>
          <td class="file-cell">${escHtml(s.example_files[0])}</td>
        </tr>`,
    )
    .join("");
  return `
    <div id="tab-surprises" class="tab-panel">
      <h2>Surprise Connections</h2>
      <p>Unexpected coupling between communities.</p>
      <table>
        <thead><tr><th>Community A</th><th>Community B</th><th>Score</th><th>Edges</th><th>Example File</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function buildWikiSection(data: LensData): string {
  if (data.wiki_pages.length === 0) {
    return `<div id="tab-wiki" class="tab-panel"><h2>Wiki</h2><p class="empty">No wiki pages available.</p></div>`;
  }
  const navItems = data.wiki_pages
    .map(
      (p, i) =>
        `<li><a class="wiki-nav-link${i === 0 ? " active" : ""}" data-slug="${escHtml(p.slug)}" href="#">${escHtml(p.title)}</a></li>`,
    )
    .join("");
  return `
    <div id="tab-wiki" class="tab-panel">
      <h2>Wiki</h2>
      <div class="wiki-layout">
        <nav class="wiki-nav"><ul>${navItems}</ul></nav>
        <div id="wiki-content" class="wiki-content">
          <div id="wiki-rendered"></div>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Inline scripts
// ---------------------------------------------------------------------------

function buildTabScript(): string {
  return `
  (function() {
    var tabs = document.querySelectorAll('.tab-btn');
    var panels = document.querySelectorAll('.tab-panel');
    tabs.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var target = btn.getAttribute('data-tab');
        tabs.forEach(function(b) { b.classList.remove('active'); });
        panels.forEach(function(p) { p.classList.remove('active'); });
        btn.classList.add('active');
        var panel = document.getElementById('tab-' + target);
        if (panel) panel.classList.add('active');
      });
    });
  })();`;
}

function buildWikiScript(): string {
  return `
  (function() {
    var links = document.querySelectorAll('.wiki-nav-link');
    var rendered = document.getElementById('wiki-rendered');
    function showPage(slug) {
      var page = DATA.wiki_pages.find(function(p) { return p.slug === slug; });
      if (!page || !rendered) return;
      rendered.innerHTML = (typeof marked !== 'undefined') ? marked.parse(page.content) : '<pre>' + page.content + '</pre>';
    }
    links.forEach(function(link) {
      link.addEventListener('click', function(e) {
        e.preventDefault();
        links.forEach(function(l) { l.classList.remove('active'); });
        link.classList.add('active');
        showPage(link.getAttribute('data-slug'));
      });
    });
    // Render first page
    if (links.length > 0) showPage(links[0].getAttribute('data-slug'));
  })();`;
}

function buildChordScript(data: LensData): string {
  if (data.communities.length < 2) return "";
  const names = JSON.stringify(data.communities.map((c) => c.name));
  // Build a simple NxN matrix based on surprise edge_count
  const n = data.communities.length;
  const nameIndex = new Map(data.communities.map((c, i) => [c.name, i]));
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0) as number[]);
  for (const s of data.surprises) {
    const a = nameIndex.get(s.community_a);
    const b = nameIndex.get(s.community_b);
    if (a !== undefined && b !== undefined) {
      (matrix[a] as number[])[b] = s.edge_count;
      (matrix[b] as number[])[a] = s.edge_count;
    }
  }
  return `
  (function() {
    var el = document.getElementById('chord');
    if (!el || typeof d3 === 'undefined') return;
    var names = ${names};
    var matrix = ${JSON.stringify(matrix)};
    var width = 360, height = 360, outerR = 150, innerR = 120;
    var color = d3.scaleOrdinal(d3.schemeTableau10);
    var svg = d3.select(el).append('svg')
      .attr('viewBox', [-width/2, -height/2, width, height].join(' '))
      .attr('width', width).attr('height', height);
    var chord = d3.chord().padAngle(0.05)(matrix);
    var arc = d3.arc().innerRadius(innerR).outerRadius(outerR);
    var ribbon = d3.ribbon().radius(innerR);
    var g = svg.append('g');
    g.append('g').selectAll('path').data(chord.groups).join('path')
      .attr('fill', function(d) { return color(String(d.index)); })
      .attr('d', function(d) { return arc(d) || ''; });
    g.append('g').selectAll('path').data(chord).join('path')
      .attr('fill', function(d) { return color(String(d.source.index)); })
      .attr('opacity', 0.7)
      .attr('d', function(d) { return ribbon(d) || ''; });
    g.append('g').selectAll('text').data(chord.groups).join('text')
      .each(function(d) { d.angle = (d.startAngle + d.endAngle) / 2; })
      .attr('transform', function(d) {
        return 'rotate(' + (d.angle * 180/Math.PI - 90) + ') translate(' + (outerR + 8) + ') ' + (d.angle > Math.PI ? 'rotate(180)' : '');
      })
      .attr('text-anchor', function(d) { return d.angle > Math.PI ? 'end' : 'start'; })
      .attr('font-size', '10px').attr('fill', '#1e293b')
      .text(function(d) { return names[d.index] || ''; });
  })();`;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function buildCss(): string {
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
         color: #1e293b; background: #f8fafc; line-height: 1.6; }
  header { background: #6366f1; color: white; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 20px; }
  .tab-bar { display: flex; gap: 4px; background: white; border-bottom: 2px solid #e2e8f0; padding: 0 24px; }
  .tab-btn { padding: 10px 18px; border: none; background: none; cursor: pointer;
             font-size: 14px; color: #64748b; border-bottom: 3px solid transparent; margin-bottom: -2px; }
  .tab-btn.active, .tab-btn:hover { color: #6366f1; border-bottom-color: #6366f1; }
  .tab-panel { display: none; padding: 24px; max-width: 960px; margin: 0 auto; }
  .tab-panel.active { display: block; }
  h2 { color: #6366f1; margin-bottom: 16px; font-size: 20px; }
  h3 { color: #475569; margin: 20px 0 10px; font-size: 16px; }
  p { margin: 8px 0; color: #475569; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; }
  th, td { border: 1px solid #e2e8f0; padding: 8px 12px; text-align: left; }
  th { background: #6366f1; color: white; font-weight: 600; }
  tr:nth-child(even) { background: #f1f5f9; }
  .file-cell { font-family: monospace; font-size: 12px; }
  .metrics { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0; }
  .metric { background: #6366f1; color: white; padding: 8px 16px; border-radius: 8px; font-size: 14px; }
  .metric b { font-size: 22px; display: block; }
  .badge { background: #e0e7ff; color: #4338ca; border-radius: 4px; padding: 2px 6px; font-size: 12px; }
  .warn { color: #dc2626; font-weight: 600; }
  .empty { color: #94a3b8; font-style: italic; }
  .community-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px;
                    padding: 12px 16px; margin: 8px 0; }
  .community-header { display: flex; justify-content: space-between; margin-bottom: 8px; }
  .community-name { font-weight: 600; color: #1e293b; }
  .community-stats { font-size: 12px; color: #64748b; }
  .cohesion-bar-bg { background: #e2e8f0; border-radius: 4px; height: 6px; margin-bottom: 4px; }
  .cohesion-bar { background: #6366f1; border-radius: 4px; height: 6px; }
  .cohesion-label { font-size: 11px; color: #64748b; }
  .low-mod-notice { color: #d97706; background: #fffbeb; border: 1px solid #fde68a;
                    padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; }
  .chord-container { display: flex; justify-content: center; margin: 16px 0; }
  .wiki-layout { display: flex; gap: 24px; }
  .wiki-nav { min-width: 180px; }
  .wiki-nav ul { list-style: none; }
  .wiki-nav-link { display: block; padding: 6px 10px; color: #475569; text-decoration: none;
                   border-radius: 4px; font-size: 14px; }
  .wiki-nav-link.active, .wiki-nav-link:hover { background: #e0e7ff; color: #4338ca; }
  .wiki-content { flex: 1; background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; }
  #wiki-rendered h1, #wiki-rendered h2, #wiki-rendered h3 { color: #6366f1; margin: 16px 0 8px; }
  #wiki-rendered p { margin: 8px 0; }
  #wiki-rendered code { background: #f1f5f9; padding: 2px 4px; border-radius: 3px; font-size: 13px; }
  #wiki-rendered pre { background: #f1f5f9; padding: 12px; border-radius: 6px; overflow-x: auto; }
  #wiki-rendered ul, #wiki-rendered ol { padding-left: 20px; margin: 8px 0; }`;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export function buildLensHtml(data: LensData): string {
  const safeRepo = escHtml(data.repo);

  const tabButtons = [
    { id: "overview", label: "Overview" },
    { id: "communities", label: "Communities" },
    { id: "hubs", label: "Hubs" },
    { id: "surprises", label: "Surprises" },
    { id: "wiki", label: "Wiki" },
  ]
    .map(
      (t, i) =>
        `<button class="tab-btn${i === 0 ? " active" : ""}" data-tab="${t.id}">${t.label}</button>`,
    )
    .join("");

  const sections = [
    buildOverviewSection(data),
    buildCommunitiesSection(data),
    buildHubsSection(data),
    buildSurprisesSection(data),
    buildWikiSection(data),
  ].join("\n");

  // Escape HTML-sensitive chars in JSON to prevent XSS (e.g. </script> injection, < in strings)
  const jsonStr = JSON.stringify(data)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const inlineData = `const DATA = ${jsonStr};`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeSift Lens &mdash; ${safeRepo}</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@9/marked.min.js"></script>
<style>${buildCss()}</style>
</head>
<body>
<header>
  <h1>CodeSift Lens &mdash; ${safeRepo}</h1>
</header>
<nav class="tab-bar">${tabButtons}</nav>
<main>${sections}</main>
<script>${inlineData}</script>
<script>${buildTabScript()}</script>
<script>${buildWikiScript()}</script>
<script>${buildChordScript(data)}</script>
</body>
</html>`;
}

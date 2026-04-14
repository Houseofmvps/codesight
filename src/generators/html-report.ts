import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScanResult } from "../types.js";

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function generateHtmlReport(
  result: ScanResult,
  outputDir: string
): Promise<string> {
  const filePath = join(outputDir, "report.html");
  const html = buildHtml(result);
  await writeFile(filePath, html);
  return filePath;
}

function buildHtml(r: ScanResult): string {
  const { project, routes, schemas, components, libs, config, middleware, graph, tokenStats } = r;
  const fw = project.frameworks.join(", ") || "generic";
  const orm = project.orms.join(", ") || "none";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(project.name)} — codesight report</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--card:#12121a;--border:#1e1e2e;--text:#e0e0e8;--muted:#6b6b80;--accent:#6366f1;--accent2:#22d3ee;--green:#22c55e;--orange:#f59e0b;--red:#ef4444;--pink:#ec4899}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:2rem;max-width:1400px;margin:0 auto;line-height:1.6}
h1{font-size:2.5rem;font-weight:800;background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:.25rem}
.subtitle{color:var(--muted);font-size:1rem;margin-bottom:2rem}
.stack-badge{display:inline-block;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:2px 10px;font-size:.85rem;color:var(--accent2);margin:0 4px 4px 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem;margin:2rem 0}
.stat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem;text-align:center}
.stat-value{font-size:2rem;font-weight:800;background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.stat-label{color:var(--muted);font-size:.85rem;margin-top:.25rem}
.token-hero{background:linear-gradient(135deg,#1a1a2e,#16213e);border:1px solid var(--accent);border-radius:16px;padding:2rem;margin:2rem 0;text-align:center}
.token-saved{font-size:3rem;font-weight:900;color:var(--green)}
.token-detail{color:var(--muted);font-size:.9rem;margin-top:.5rem}
.section{margin:2.5rem 0}
.section h2{font-size:1.4rem;font-weight:700;margin-bottom:1rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1rem;transition:border-color .2s}
.card:hover{border-color:var(--accent)}
.card-title{font-weight:700;font-size:1rem;margin-bottom:.5rem}
.card-meta{color:var(--muted);font-size:.8rem}
.tag{display:inline-block;background:rgba(99,102,241,.15);color:var(--accent);border-radius:4px;padding:1px 6px;font-size:.75rem;margin:1px}
.tag-auth{background:rgba(239,68,68,.15);color:var(--red)}
.tag-db{background:rgba(34,211,238,.15);color:var(--accent2)}
.tag-ai{background:rgba(236,72,153,.15);color:var(--pink)}
.tag-payment{background:rgba(245,158,11,.15);color:var(--orange)}
.tag-email{background:rgba(34,197,94,.15);color:var(--green)}
.tag-queue{background:rgba(168,85,247,.15);color:#a855f7}
.tag-cache{background:rgba(245,158,11,.15);color:var(--orange)}
.method{font-weight:700;font-size:.8rem;padding:2px 6px;border-radius:4px;margin-right:6px}
.method-GET{background:rgba(34,197,94,.2);color:var(--green)}
.method-POST{background:rgba(99,102,241,.2);color:var(--accent)}
.method-PUT{background:rgba(245,158,11,.2);color:var(--orange)}
.method-PATCH{background:rgba(245,158,11,.2);color:var(--orange)}
.method-DELETE{background:rgba(239,68,68,.2);color:var(--red)}
.method-ALL{background:rgba(107,107,128,.2);color:var(--muted)}
.route-path{font-family:'Fira Code',monospace;font-size:.9rem}
.route-contract{color:var(--muted);font-size:.8rem;font-style:italic;margin-left:.5rem}
.field{display:flex;gap:.5rem;padding:3px 0;font-size:.9rem}
.field-name{font-family:monospace;color:var(--accent2)}
.field-type{color:var(--muted);font-family:monospace}
.field-flags{display:flex;gap:3px}
.flag{font-size:.7rem;padding:0 4px;border-radius:3px;background:rgba(99,102,241,.1);color:var(--accent)}
.flag-pk{background:rgba(245,158,11,.2);color:var(--orange)}
.flag-fk{background:rgba(34,211,238,.2);color:var(--accent2)}
.flag-unique{background:rgba(236,72,153,.2);color:var(--pink)}
.hot-bar{height:8px;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:4px;margin-top:4px}
.component-props{color:var(--muted);font-size:.85rem}
.badge-client{background:rgba(34,197,94,.15);color:var(--green);font-size:.75rem;padding:1px 6px;border-radius:4px}
.badge-server{background:rgba(99,102,241,.15);color:var(--accent);font-size:.75rem;padding:1px 6px;border-radius:4px}
.env-required{color:var(--red);font-weight:600;font-size:.8rem}
.env-default{color:var(--green);font-size:.8rem}
.footer{text-align:center;color:var(--muted);margin-top:4rem;padding-top:2rem;border-top:1px solid var(--border);font-size:.85rem}
.footer a{color:var(--accent);text-decoration:none}
table{width:100%;border-collapse:collapse}
table td,table th{padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);font-size:.9rem}
table th{color:var(--muted);font-size:.8rem;font-weight:600;text-transform:uppercase}
</style>
</head>
<body>

<h1>${escapeHtml(project.name)}</h1>
<div class="subtitle">AI Context Map — generated by codesight</div>

<div>
${project.frameworks.map((f) => `<span class="stack-badge">${escapeHtml(f)}</span>`).join("")}
${project.orms.map((o) => `<span class="stack-badge">${escapeHtml(o)}</span>`).join("")}
<span class="stack-badge">${escapeHtml(project.componentFramework)}</span>
<span class="stack-badge">${escapeHtml(project.language)}</span>
${project.repoType !== "single" ? `<span class="stack-badge">${escapeHtml(project.repoType)}</span>` : ""}
</div>

<div class="token-hero">
  <div class="token-saved">~${tokenStats.saved.toLocaleString()} tokens saved</div>
  <div class="token-detail">
    Output: ${tokenStats.outputTokens.toLocaleString()} tokens — Exploration cost without codesight: ~${tokenStats.estimatedExplorationTokens.toLocaleString()} tokens — ${tokenStats.fileCount} files scanned
  </div>
</div>

<div class="stats">
  <div class="stat"><div class="stat-value">${routes.length}</div><div class="stat-label">Routes</div></div>
  <div class="stat"><div class="stat-value">${schemas.length}</div><div class="stat-label">Models</div></div>
  <div class="stat"><div class="stat-value">${components.length}</div><div class="stat-label">Components</div></div>
  <div class="stat"><div class="stat-value">${libs.length}</div><div class="stat-label">Libraries</div></div>
  <div class="stat"><div class="stat-value">${config.envVars.length}</div><div class="stat-label">Env Vars</div></div>
  <div class="stat"><div class="stat-value">${middleware.length}</div><div class="stat-label">Middleware</div></div>
  <div class="stat"><div class="stat-value">${graph.edges.length}</div><div class="stat-label">Import Links</div></div>
</div>

${routes.length > 0 ? `
<div class="section">
<h2>Routes</h2>
<table>
<tr><th>Method</th><th>Path</th><th>Contract</th><th>Tags</th><th>File</th></tr>
${routes.map((r) => `<tr>
  <td><span class="method method-${escapeHtml(r.method)}">${escapeHtml(r.method)}</span></td>
  <td class="route-path">${escapeHtml(r.path)}${r.params ? ` <span class="route-contract">params: ${escapeHtml(r.params.join(", "))}</span>` : ""}</td>
  <td>${r.requestType ? `<span class="route-contract">in: ${escapeHtml(r.requestType)}</span>` : ""}${r.responseType ? `<span class="route-contract">out: ${escapeHtml(r.responseType)}</span>` : ""}</td>
  <td>${r.tags.map((t) => `<span class="tag tag-${escapeHtml(t)}">${escapeHtml(t)}</span>`).join("")}</td>
  <td class="card-meta">${escapeHtml(r.file)}</td>
</tr>`).join("\n")}
</table>
</div>` : ""}

${schemas.length > 0 ? `
<div class="section">
<h2>Schema</h2>
<div class="grid">
${schemas.map((m) => `<div class="card">
  <div class="card-title">${escapeHtml(m.name)} <span class="card-meta">${escapeHtml(m.orm)}</span></div>
  ${m.fields.map((f) => `<div class="field">
    <span class="field-name">${escapeHtml(f.name)}</span>
    <span class="field-type">${escapeHtml(f.type)}</span>
    <span class="field-flags">${f.flags.map((fl) => `<span class="flag flag-${escapeHtml(fl)}">${escapeHtml(fl)}</span>`).join("")}</span>
  </div>`).join("\n")}
  ${m.relations.length > 0 ? `<div class="card-meta" style="margin-top:6px">Relations: ${escapeHtml(m.relations.join(", "))}</div>` : ""}
</div>`).join("\n")}
</div>
</div>` : ""}

${components.length > 0 ? `
<div class="section">
<h2>Components</h2>
<div class="grid">
${components.map((c) => `<div class="card">
  <div class="card-title">${escapeHtml(c.name)} ${c.isClient ? '<span class="badge-client">client</span>' : ""}${c.isServer ? '<span class="badge-server">server</span>' : ""}</div>
  ${c.props.length > 0 ? `<div class="component-props">props: ${escapeHtml(c.props.join(", "))}</div>` : ""}
  <div class="card-meta">${escapeHtml(c.file)}</div>
</div>`).join("\n")}
</div>
</div>` : ""}

${graph.hotFiles.length > 0 ? `
<div class="section">
<h2>Dependency Hot Files</h2>
<div class="grid">
${graph.hotFiles.slice(0, 12).map((h) => {
    const maxImports = graph.hotFiles[0]?.importedBy || 1;
    const pct = Math.round((h.importedBy / maxImports) * 100);
    return `<div class="card">
  <div class="card-title" style="font-size:.9rem">${escapeHtml(h.file)}</div>
  <div class="card-meta">imported by ${h.importedBy} files</div>
  <div class="hot-bar" style="width:${pct}%"></div>
</div>`;
  }).join("\n")}
</div>
</div>` : ""}

${config.envVars.length > 0 ? `
<div class="section">
<h2>Environment Variables</h2>
<table>
<tr><th>Variable</th><th>Status</th><th>Source</th></tr>
${config.envVars.map((e) => `<tr>
  <td><code>${escapeHtml(e.name)}</code></td>
  <td>${e.hasDefault ? '<span class="env-default">has default</span>' : '<span class="env-required">required</span>'}</td>
  <td class="card-meta">${escapeHtml(e.source)}</td>
</tr>`).join("\n")}
</table>
</div>` : ""}

${middleware.length > 0 ? `
<div class="section">
<h2>Middleware</h2>
<div class="grid">
${middleware.map((m) => `<div class="card">
  <div class="card-title">${escapeHtml(m.name)} <span class="tag tag-${escapeHtml(m.type)}">${escapeHtml(m.type)}</span></div>
  <div class="card-meta">${escapeHtml(m.file)}</div>
</div>`).join("\n")}
</div>
</div>` : ""}

<div class="footer">
  Generated by <a href="https://github.com/Houseofmvps/codesight">codesight</a> — see your codebase clearly
</div>

</body>
</html>`;
}

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ScanResult, RouteInfo, SchemaModel, DetectionMethod, LibExport } from "../types.js";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowTs(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/** Routes/models detected via AST are silent. Regex-inferred ones get a badge so AI knows accuracy is lower. */
function confidenceBadge(c?: DetectionMethod): string {
  return c === "regex" ? " `[inferred]`" : "";
}

// ─── Domain detection ─────────────────────────────────────────────────────────

interface Domain {
  name: string;
  routes: RouteInfo[];
}

/**
 * Extract domain name from the source file path.
 * e.g. src/routes/payments.ts → "payments"
 *      apps/api/src/routes/money-pages.ts → "money-pages"
 * Returns null for generic filenames (index, server, app, etc.)
 */
function domainFromFile(file: string): string | null {
  if (!file) return null;
  const parts = file.replace(/\\/g, "/").split("/");

  // Look for a routes/controllers/handlers directory and use the next segment
  let containerIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (["routes", "routers", "handlers", "controllers", "endpoints"].includes(parts[i])) {
      containerIdx = i;
      break;
    }
  }
  if (containerIdx >= 0 && containerIdx + 1 < parts.length) {
    const name = parts[containerIdx + 1].replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt)$/, "");
    const generic = new Set(["index", "server", "app", "main", "router", "routes", "api", "handler", "handlers", "base"]);
    if (!generic.has(name) && name.length > 1) return name;
  }

  // Fall back to the file's own name
  const basename = parts[parts.length - 1].replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt)$/, "");
  const generic = new Set([
    "index", "server", "app", "main", "router", "routes", "api",
    "handler", "handlers", "rest", "cli", "server", "dashboard",
  ]);
  if (!generic.has(basename) && basename.length > 1 && !basename.startsWith("_")) {
    return basename;
  }
  return null;
}

/**
 * Sanitize a string for safe use as a filename on all platforms (Windows is strictest).
 * Replaces `<>:"/\|?*` and control chars with `-`. Collapses runs and trims edges.
 */
function safeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase() || "section";
}

function detectDomains(routes: RouteInfo[]): Domain[] {
  const buckets = new Map<string, RouteInfo[]>();

  for (const route of routes) {
    const path = route.path.toLowerCase();

    let domain: string;

    // ── tRPC: group by first dotted path segment so procedures never bleed into HTTP domains ──
    if (route.framework === "trpc") {
      domain = route.path.split(".")[0] || "procedures";
    }
    // ── Infra: health/monitoring/low-level transport endpoints ──────────────
    else if (
      path === "/" ||
      /^\/(health|healthz|metrics|status|ping|ready|readyz|live|livez|mcp|sse|messages)(\/|$)/.test(path)
    ) {
      domain = "infra";
    }
    // ── Auth: path EXPLICITLY about authentication ───────────────────────────
    // NOTE: auth TAG means "protected by auth middleware" — not a domain marker
    else if (
      /\/(auth|login|logout|signup|sign-in|sign-up|sign-out|register|oauth|sso|saml|token|refresh|password|forgot|reset|verify|confirm)(\/|$)/.test(path) ||
      /\/(google|github|discord|twitter|reddit|microsoft|apple)(\/callback)?(\/|$)/.test(path)
    ) {
      domain = "auth";
    }
    // ── Payments: billing / subscription / checkout ──────────────────────────
    else if (
      /\/(payment|billing|stripe|polar|lemon|paddle|checkout|subscription|subscribe|invoice|webhook|webhooks|pricing)(\/|$)/.test(path)
    ) {
      domain = "payments";
    }
    // ── Admin ────────────────────────────────────────────────────────────────
    else if (/\/admin(\/|$)/.test(path)) {
      domain = "admin";
    }
    // ── File-based grouping (most reliable for resource routes) ──────────────
    else {
      const fileDomain = domainFromFile(route.file);
      if (fileDomain) {
        domain = fileDomain;
      } else {
        // Path segment grouping: first non-param, non-version segment.
        // Route param syntaxes covered: Express `:id`, OpenAPI `{id}`, Flask `<id>` / `<string:id>`.
        const segments = route.path
          .split("/")
          .filter(
            (p) =>
              p &&
              !p.startsWith(":") &&
              !p.startsWith("{") &&
              !p.startsWith("<") &&
              !["api", "v1", "v2", "v3"].includes(p)
          );
        domain = segments[0]?.replace(/_/g, "-") || "api";
      }
    }

    if (!buckets.has(domain)) buckets.set(domain, []);
    buckets.get(domain)!.push(route);
  }

  // Sort: auth first, payments second, infra last, rest alphabetical
  const order = ["auth", "payments"];
  const last = ["infra", "api"];
  const middle = [...buckets.keys()].filter((k) => !order.includes(k) && !last.includes(k)).sort();
  const sorted = [...order, ...middle, ...last].filter((k) => buckets.has(k));

  return sorted.map((name) => ({ name, routes: buckets.get(name)! }));
}

// ─── Article generators ───────────────────────────────────────────────────────

function overviewArticle(result: ScanResult): string {
  const { project, routes, schemas, components, middleware, config, graph } = result;
  const fw = project.frameworks.join(", ") || "generic";
  const orm = project.orms.join(", ") || "none";
  const lines: string[] = [];

  lines.push(`# ${project.name} — Overview`, "");
  lines.push(`> **Navigation aid.** This article shows WHERE things live (routes, models, files). Read actual source files before implementing new features or making changes.`, "");

  // One-sentence description
  const parts: string[] = [`a ${project.language} project built with ${fw}`];
  if (orm !== "none") parts.push(`using ${orm} for data persistence`);
  if (project.isMonorepo) parts.push(`organized as a monorepo`);
  lines.push(`**${project.name}** is ${parts.join(", ")}.`, "");

  if (project.isMonorepo && project.workspaces.length > 0) {
    lines.push(
      `**Workspaces:** ${project.workspaces.map((w) => `\`${w.name}\` (\`${w.path}\`)`).join(", ")}`,
      ""
    );
  }

  // Stats
  const facts: string[] = [];
  if (routes.length > 0) facts.push(`${routes.length} API routes`);
  if (schemas.length > 0) facts.push(`${schemas.length} database models`);
  if (components.length > 0) facts.push(`${components.length} UI components`);
  if (result.libs.length > 0) facts.push(`${result.libs.length} library files`);
  if (middleware.length > 0) facts.push(`${middleware.length} middleware layers`);
  if (config.envVars.length > 0) facts.push(`${config.envVars.length} environment variables`);
  if (facts.length > 0) {
    lines.push("## Scale", "", facts.join(" · "), "");
  }

  // Subsystems
  const domains = detectDomains(routes);
  if (domains.length > 0) {
    lines.push("## Subsystems", "");
    for (const d of domains) {
      const allTags = [...new Set(d.routes.flatMap((r) => r.tags))].slice(0, 5);
      const tagStr = allTags.length > 0 ? ` — touches: ${allTags.join(", ")}` : "";
      const title = d.name.charAt(0).toUpperCase() + d.name.slice(1);
      const slug = safeFilename(d.name);
      lines.push(`- **[${title}](./${slug}.md)** — ${d.routes.length} routes${tagStr}`);
    }
    lines.push("");
  }

  // Database
  if (schemas.length > 0) {
    const orms = [...new Set(schemas.map((s) => s.orm))];
    lines.push(
      `**Database:** ${orms.join(", ")}, ${schemas.length} models — see [database.md](./database.md)`,
      ""
    );
  }

  // Components
  if (components.length > 0) {
    lines.push(`**UI:** ${components.length} components (${project.componentFramework}) — see [ui.md](./ui.md)`, "");
  }

  // Libraries (non-web / library-heavy projects)
  if (result.libs.length >= 10) {
    lines.push(`**Libraries:** ${result.libs.length} files — see [libraries.md](./libraries.md)`, "");
  }

  // High-impact files
  if (graph.hotFiles.length > 0) {
    lines.push("## High-Impact Files", "");
    lines.push("Changes to these files have the widest blast radius across the codebase:", "");
    for (const hf of graph.hotFiles.slice(0, 6)) {
      lines.push(`- \`${hf.file}\` — imported by **${hf.importedBy}** files`);
    }
    lines.push("");
  }

  // Required env
  const required = config.envVars.filter((e) => !e.hasDefault);
  if (required.length > 0) {
    lines.push("## Required Environment Variables", "");
    for (const env of required.slice(0, 12)) {
      lines.push(`- \`${env.name}\` — \`${env.source}\``);
    }
    if (required.length > 12) lines.push(`- _...${required.length - 12} more_`);
    lines.push("");
  }

  lines.push("---", `_Back to [index.md](./index.md) · Generated ${today()}_`);
  return lines.join("\n");
}

function domainArticle(domain: Domain, result: ScanResult, missingFiles: Set<string> = new Set()): string {
  const { schemas, middleware, graph } = result;
  const title = domain.name.charAt(0).toUpperCase() + domain.name.slice(1);
  const lines: string[] = [];

  lines.push(`# ${title}`, "");
  lines.push(`> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.`, "");

  // Summary sentence
  const allTags = [...new Set(domain.routes.flatMap((r) => r.tags))];
  const services = allTags.filter((t) =>
    ["auth", "db", "cache", "payment", "email", "ai", "queue", "storage", "sms"].includes(t)
  );
  if (services.length > 0) {
    lines.push(
      `The ${title} subsystem handles **${domain.routes.length} routes** and touches: ${services.join(", ")}.`,
      ""
    );
  } else {
    lines.push(`The ${title} subsystem handles **${domain.routes.length} routes**.`, "");
  }

  // Routes
  lines.push("## Routes", "");
  for (const route of domain.routes) {
    const tags = route.tags.length > 0 ? ` [${route.tags.join(", ")}]` : "";
    const params =
      route.params && route.params.length > 0 ? ` params(${route.params.join(", ")})` : "";
    const contract: string[] = [];
    if (route.requestType) contract.push(`in: ${route.requestType}`);
    if (route.responseType) contract.push(`out: ${route.responseType}`);
    const contractStr = contract.length > 0 ? ` → ${contract.join(", ")}` : "";
    const mwChain =
      route.middleware && route.middleware.length > 0
        ? ` → middleware: ${route.middleware.join(" → ")}`
        : "";
    const badge = confidenceBadge(route.confidence);
    const fileWarning =
      route.file && missingFiles.has(route.file)
        ? " ⚠ _file not found — wiki stale, re-run `npx codesight --wiki`_"
        : "";
    lines.push(`- \`${route.method}\` \`${route.path}\`${params}${contractStr}${tags}${mwChain}${badge}`);
    lines.push(`  \`${route.file || "unknown"}\`${fileWarning}`);
  }
  lines.push("");

  // Middleware relevant to this domain
  const mwTypes: string[] = [];
  if (domain.name === "auth") mwTypes.push("auth");
  if (domain.name === "payments") mwTypes.push("validation");
  const relatedMw = middleware.filter((m) => mwTypes.includes(m.type));
  if (relatedMw.length > 0) {
    lines.push("## Middleware", "");
    for (const mw of relatedMw) {
      lines.push(`- **${mw.name}** (${mw.type}) — \`${mw.file}\``);
    }
    lines.push("");
  }

  // Related schema models — word-boundary match only (prevents "auth" matching "oauth_provider")
  const domainKeywords = domain.name
    .split(/[-_]/)
    .filter((k) => k.length >= 4);
  const relatedModels = schemas
    .filter((s) => {
      if (s.name.startsWith("enum:")) return false;
      // Split model name into words and require exact word match
      const modelWords = s.name.toLowerCase().split(/[_\-\s]/);
      return domainKeywords.some((kw) => modelWords.includes(kw));
    })
    .slice(0, 6);
  if (relatedModels.length > 0) {
    lines.push("## Related Models", "");
    for (const m of relatedModels) {
      lines.push(`- **${m.name}** (${m.fields.length} fields) → [database.md](./database.md)`);
    }
    lines.push("");
  }

  // Files with high blast radius in this domain
  const domainFiles = [...new Set(domain.routes.map((r) => r.file))];
  const hotInDomain = graph.hotFiles.filter((hf) => domainFiles.includes(hf.file));
  if (hotInDomain.length > 0) {
    lines.push("## High-Impact Files", "");
    for (const hf of hotInDomain) {
      lines.push(`- \`${hf.file}\` — imported by ${hf.importedBy} files`);
    }
    lines.push("");
  }

  // Source files — explicit read list so AI cannot skip to implementation without opening source
  const sourceFiles = [...new Set(domain.routes.map((r) => r.file).filter(Boolean))];
  if (sourceFiles.length > 0) {
    lines.push("## Source Files", "");
    lines.push("Read these before implementing or modifying this subsystem:");
    for (const f of sourceFiles) {
      const stale =
        missingFiles.has(f)
          ? " ⚠ _not found — re-run `npx codesight --wiki`_"
          : "";
      lines.push(`- \`${f}\`${stale}`);
    }
    lines.push("");
  }

  lines.push("---", `_Back to [overview.md](./overview.md)_`);
  return lines.join("\n");
}

function databaseArticle(result: ScanResult): string {
  const { schemas, graph } = result;
  const lines: string[] = [];

  lines.push("# Database", "");
  lines.push(`> **Navigation aid.** Schema shapes and field types extracted via AST. Read the actual schema source files before writing migrations or query logic.`, "");

  if (schemas.length === 0) {
    lines.push("No database models detected.");
    return lines.join("\n");
  }

  const orms = [...new Set(schemas.map((s) => s.orm))];
  lines.push(`**${orms.join(", ")}** — ${schemas.length} models`, "");

  const byOrm = new Map<string, SchemaModel[]>();
  for (const model of schemas) {
    if (!byOrm.has(model.orm)) byOrm.set(model.orm, []);
    byOrm.get(model.orm)!.push(model);
  }

  for (const [orm, models] of byOrm) {
    if (byOrm.size > 1) {
      lines.push(`## ${orm}`, "");
    }

    for (const model of models) {
      if (model.name.startsWith("enum:")) {
        const name = model.name.replace("enum:", "");
        const values = model.fields.map((f) => f.name).join(" | ");
        lines.push(`### enum ${name}`, "", values, "");
        continue;
      }

      lines.push(`### ${model.name}${confidenceBadge(model.confidence)}`, "");

      const pkField = model.fields.find((f) => f.flags.includes("pk"));
      const fkFields = model.fields.filter((f) => f.flags.includes("fk"));
      const meta: string[] = [];
      if (pkField) meta.push(`pk: \`${pkField.name}\` (${pkField.type})`);
      if (fkFields.length > 0) meta.push(`fk: ${fkFields.map((f) => f.name).join(", ")}`);
      if (meta.length > 0) lines.push(meta.join(" · "), "");

      for (const field of model.fields) {
        const flags = field.flags.length > 0 ? ` _(${field.flags.join(", ")})_` : "";
        lines.push(`- \`${field.name}\`: ${field.type}${flags}`);
      }
      if (model.relations.length > 0) {
        lines.push(`- _relations_: ${model.relations.join(", ")}`);
      }
      lines.push("");
    }
  }

  // Schema source files — derived from import graph
  const dbSourceFiles = graph.hotFiles.filter((hf) =>
    /\/(db|schema|model|drizzle|prisma|migrate)/.test(hf.file.toLowerCase())
  );
  if (dbSourceFiles.length > 0) {
    lines.push("## Schema Source Files", "");
    lines.push("Read and edit these files when adding columns, creating migrations, or changing relations:", "");
    for (const hf of dbSourceFiles) {
      lines.push(`- \`${hf.file}\` — imported by **${hf.importedBy}** files`);
    }
    lines.push("");
  } else {
    lines.push("## Schema Source Files", "");
    lines.push("Search for ORM schema declarations:");
    lines.push("- Drizzle: `pgTable` / `mysqlTable` / `sqliteTable`");
    lines.push("- Prisma: `prisma/schema.prisma`");
    lines.push("- TypeORM: `@Entity()` decorator");
    lines.push("- SQLAlchemy: class inheriting `Base`");
    lines.push("");
  }

  lines.push("---", `_Back to [overview.md](./overview.md)_`);
  return lines.join("\n");
}

function uiArticle(result: ScanResult): string {
  const { components, project } = result;
  const lines: string[] = [];

  lines.push("# UI", "");
  lines.push(`> **Navigation aid.** Component inventory and prop signatures extracted via AST. Read the source files before adding props or modifying component logic.`, "");
  lines.push(
    `**${components.length} components** (${project.componentFramework})`,
    ""
  );

  const clientComponents = components.filter((c) => c.isClient);
  const serverComponents = components.filter((c) => c.isServer);
  const shared = components.filter((c) => !c.isClient && !c.isServer);

  if (serverComponents.length > 0) {
    lines.push("## Server Components", "");
    for (const c of serverComponents) {
      const props = c.props.length > 0 ? ` — props: ${c.props.join(", ")}` : "";
      lines.push(`- **${c.name}**${props} — \`${c.file}\``);
    }
    lines.push("");
  }

  if (clientComponents.length > 0) {
    lines.push("## Client Components", "");
    for (const c of clientComponents) {
      const props = c.props.length > 0 ? ` — props: ${c.props.join(", ")}` : "";
      lines.push(`- **${c.name}**${props} — \`${c.file}\``);
    }
    lines.push("");
  }

  if (shared.length > 0) {
    lines.push("## Components", "");
    for (const c of shared) {
      const props = c.props.length > 0 ? ` — props: ${c.props.join(", ")}` : "";
      lines.push(`- **${c.name}**${props} — \`${c.file}\``);
    }
    lines.push("");
  }

  lines.push("---", `_Back to [overview.md](./overview.md)_`);
  return lines.join("\n");
}

// ─── Library article (non-web projects) ──────────────────────────────────────

/**
 * Derive a human-readable group name from a relative file path.
 * Strips generic top-level dirs (src, lib, source) so that
 * "src/engine/world.ts" → "engine" and "lib/utils/parse.ts" → "utils".
 */
function libGroupKey(file: string): string {
  const parts = file.replace(/\\/g, "/").split("/");
  const GENERIC = new Set(["src", "lib", "source", "packages", "apps", "modules", "core", "internal"]);
  if (parts.length >= 2 && GENERIC.has(parts[0])) return parts[1];
  return parts[0];
}

/**
 * Generate a libraries.md article grouping lib files by top-level source directory.
 * Emitted when a project has significant library code but few/no HTTP routes or ORM models.
 */
function librariesArticle(libs: LibExport[]): string {
  const lines: string[] = [];
  lines.push("# Libraries", "");
  lines.push(
    `> **Navigation aid.** Library inventory extracted via AST. Read the source files listed here before modifying exported functions.`,
    ""
  );

  // Group by top-level directory
  const groups = new Map<string, LibExport[]>();
  for (const lib of libs) {
    const key = libGroupKey(lib.file);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(lib);
  }

  // Sort groups: more files first, then alphabetical
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  lines.push(
    `**${libs.length} library files** across ${sorted.length} module${sorted.length !== 1 ? "s" : ""}`,
    ""
  );

  for (const [group, files] of sorted) {
    const title = group.charAt(0).toUpperCase() + group.slice(1);
    lines.push(`## ${title} (${files.length} files)`, "");

    // Sort files within group: most exports first
    const byExports = [...files].sort((a, b) => b.exports.length - a.exports.length);
    const shown = byExports.slice(0, 25);

    for (const lib of shown) {
      const topExports = lib.exports
        .slice(0, 6)
        .map((e) => e.name)
        .join(", ");
      const exStr = topExports ? ` — ${topExports}${lib.exports.length > 6 ? ", …" : ""}` : "";
      lines.push(`- \`${lib.file}\`${exStr}`);
    }
    if (byExports.length > 25) lines.push(`- _…and ${byExports.length - 25} more files_`);
    lines.push("");
  }

  lines.push("---", `_Back to [overview.md](./overview.md)_`);
  return lines.join("\n");
}

function indexFile(result: ScanResult, articles: string[]): string {
  const { project, routes, schemas, components, config } = result;
  const lines: string[] = [];

  lines.push(`# ${project.name} — Wiki`, "");
  lines.push(`_Generated ${today()} — re-run \`npx codesight --wiki\` if the codebase has changed._`, "");
  lines.push(
    `Structural map compiled from source code via AST. No LLM — deterministic, 200ms.`,
    ""
  );
  lines.push(
    `> **How to use safely:** These articles tell you WHERE things live and WHAT exists. They do not show full implementation logic. Always read the actual source files before implementing new features or making changes. Never infer how a function works from the wiki alone.`,
    ""
  );

  lines.push("## Articles", "");
  for (const article of ["overview.md", ...articles.filter((a) => a !== "overview.md")]) {
    const name = article.replace(".md", "");
    const title = name.charAt(0).toUpperCase() + name.slice(1);
    lines.push(`- [${title}](./${article})`);
  }
  lines.push("");

  lines.push("## Quick Stats", "");
  lines.push(`- Routes: **${routes.length}**`);
  lines.push(`- Models: **${schemas.length}**`);
  lines.push(`- Components: **${components.length}**`);
  const req = config.envVars.filter((e) => !e.hasDefault).length;
  const opt = config.envVars.filter((e) => e.hasDefault).length;
  lines.push(`- Env vars: **${req}** required, **${opt}** with defaults`);
  lines.push("");

  lines.push("## How to Use", "");
  lines.push("- **New session:** read `index.md` (this file) for orientation — WHERE things are");
  lines.push("- **Architecture question:** read `overview.md` (~500 tokens)");
  lines.push("- **Domain question:** read the relevant article, then **read those source files**");
  if (articles.includes("database.md")) {
    lines.push("- **Database question:** read `database.md`, then read the actual schema files");
  }
  if (articles.includes("libraries.md")) {
    lines.push("- **Library question:** read `libraries.md`, then read the listed source files");
  }
  lines.push("- **Before implementing anything:** read the source files listed in the article");
  lines.push("- **Full source context:** read `.codesight/CODESIGHT.md`");
  lines.push("");

  lines.push("## What the Wiki Does Not Cover", "");
  lines.push("These exist in your codebase but are **not** reflected in wiki articles:");
  lines.push("- Routes registered dynamically at runtime (loops, plugin factories, `app.use(dynamicRouter)`)");
  lines.push("- Internal routes from npm packages (e.g. Better Auth's built-in `/api/auth/*` endpoints)");
  lines.push("- WebSocket and SSE handlers");
  lines.push("- Raw SQL tables not declared through an ORM");
  lines.push("- Computed or virtual fields absent from schema declarations");
  lines.push("- TypeScript types that are not actual database columns");
  lines.push("- Routes marked `[inferred]` were detected via regex and may have lower precision");
  lines.push("- gRPC, tRPC, and GraphQL resolvers may be partially captured");
  lines.push("");
  lines.push("When in doubt, search the source. The wiki is a starting point, not a complete inventory.", "");

  lines.push("---", `_Last compiled: ${today()} · ${articles.length + 1} articles · [codesight](https://github.com/Houseofmvps/codesight)_`);
  return lines.join("\n");
}

async function appendLog(logPath: string, entry: string): Promise<void> {
  const newEntry = `## [${nowTs()}] ${entry}`;
  let existing = "";
  try {
    existing = await readFile(logPath, "utf-8");
  } catch {
    // first run — file doesn't exist yet
  }

  // Split into entries, keep last 19, append new one (total cap: 20)
  const entries = existing
    .split(/\n(?=## \[)/)
    .map((e) => e.trim())
    .filter((e) => e.startsWith("## ["));
  const recent = entries.slice(-19);
  recent.push(newEntry);

  const header = "# Wiki Log\n\nHistory of `npx codesight --wiki` runs. Capped at 20 entries.\n\n";
  await writeFile(logPath, header + recent.join("\n\n") + "\n");
}

// ─── Main export ─────────────────────────────────────────────────────────────

export interface WikiResult {
  articles: string[];
  wikiDir: string;
  tokenEstimate: number;
}

export async function generateWiki(
  result: ScanResult,
  outputDir: string
): Promise<WikiResult> {
  const wikiDir = join(outputDir, "wiki");
  await mkdir(wikiDir, { recursive: true });

  // Pre-check: find route source files that no longer exist on disk
  // A missing file means the wiki is referencing deleted/renamed code — flag it
  const projectRoot = result.project.root;
  const missingFiles = new Set<string>();
  for (const route of result.routes) {
    if (route.file) {
      const abs = route.file.startsWith("/") ? route.file : join(projectRoot, route.file);
      if (!existsSync(abs)) missingFiles.add(route.file);
    }
  }

  const articles: string[] = [];
  let totalChars = 0;

  // overview.md — always
  const overview = overviewArticle(result);
  await writeFile(join(wikiDir, "overview.md"), overview);
  articles.push("overview.md");
  totalChars += overview.length;

  // database.md — if schemas exist
  if (result.schemas.length > 0) {
    const db = databaseArticle(result);
    await writeFile(join(wikiDir, "database.md"), db);
    articles.push("database.md");
    totalChars += db.length;
  }

  // domain articles from routes
  const domains = detectDomains(result.routes);
  const usedSlugs = new Set<string>(articles);
  for (const domain of domains) {
    const content = domainArticle(domain, result, missingFiles);
    let slug = safeFilename(domain.name);
    let filename = `${slug}.md`;
    let n = 2;
    while (usedSlugs.has(filename)) {
      filename = `${slug}-${n++}.md`;
    }
    usedSlugs.add(filename);
    await writeFile(join(wikiDir, filename), content);
    articles.push(filename);
    totalChars += content.length;
  }

  // ui.md — if components exist
  if (result.components.length > 0) {
    const ui = uiArticle(result);
    await writeFile(join(wikiDir, "ui.md"), ui);
    articles.push("ui.md");
    totalChars += ui.length;
  }

  // libraries.md — when significant library code exists (game engines, CLI tools,
  // data pipelines, monorepo packages — projects without HTTP routes / ORM schemas)
  const LIB_THRESHOLD = 10;
  if (result.libs.length >= LIB_THRESHOLD) {
    const lib = librariesArticle(result.libs);
    await writeFile(join(wikiDir, "libraries.md"), lib);
    articles.push("libraries.md");
    totalChars += lib.length;
  }

  // index.md
  const index = indexFile(result, articles);
  await writeFile(join(wikiDir, "index.md"), index);
  totalChars += index.length;

  // log.md
  const logPath = join(wikiDir, "log.md");
  const logEntry = `scan | ${result.routes.length} routes, ${result.schemas.length} models, ${result.components.length} components → ${articles.length + 1} articles`;
  await appendLog(logPath, logEntry);

  // rough token estimate: ~4 chars per token
  const tokenEstimate = Math.round(totalChars / 4);

  return { articles, wikiDir, tokenEstimate };
}

export async function readWikiArticle(
  outputDir: string,
  article: string
): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  const { resolve, sep } = await import("node:path");
  const name = article.endsWith(".md") ? article : `${article}.md`;
  const wikiDir = resolve(outputDir, "wiki");
  const resolved = resolve(wikiDir, name);
  if (!resolved.startsWith(wikiDir + sep) && resolved !== wikiDir) return null;
  try {
    return await readFile(resolved, "utf-8");
  } catch {
    return null;
  }
}

export async function listWikiArticles(outputDir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    const files = await readdir(join(outputDir, "wiki"));
    return files.filter((f) => f.endsWith(".md") && f !== "log.md");
  } catch {
    return [];
  }
}

export async function lintWiki(
  result: ScanResult,
  outputDir: string
): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const wikiDir = join(outputDir, "wiki");
  const articles = await listWikiArticles(outputDir);

  if (articles.length === 0) {
    return "Wiki not generated yet. Run `npx codesight --wiki` first.";
  }

  const issues: string[] = [];
  const suggestions: string[] = [];

  // Check for orphan articles (not linked from index)
  let indexContent = "";
  try {
    indexContent = await readFile(join(wikiDir, "index.md"), "utf-8");
  } catch {}

  for (const article of articles) {
    if (article === "index.md") continue;
    if (!indexContent.includes(article)) {
      issues.push(`Orphan: \`${article}\` not linked from index.md`);
    }
  }

  // Check for missing cross-links (domain articles not linking back to overview)
  for (const article of articles) {
    if (article === "index.md" || article === "overview.md") continue;
    try {
      const content = await readFile(join(wikiDir, article), "utf-8");
      if (!content.includes("overview.md")) {
        issues.push(`Missing backlink: \`${article}\` does not link to overview.md`);
      }
    } catch {}
  }

  // Suggestions based on result
  if (result.schemas.length > 0 && !articles.includes("database.md")) {
    suggestions.push("Suggestion: schema models found but database.md missing — re-run `--wiki`");
  }

  if (result.components.length > 0 && !articles.includes("ui.md")) {
    suggestions.push("Suggestion: UI components found but ui.md missing — re-run `--wiki`");
  }

  const lines: string[] = [];
  lines.push(`## Wiki Health Check`);
  lines.push(`Articles: ${articles.length} | Issues: ${issues.length} | Suggestions: ${suggestions.length}`);
  lines.push("");

  if (issues.length === 0 && suggestions.length === 0) {
    lines.push("Wiki is healthy. All articles are cross-linked.");
  } else {
    for (const issue of issues) lines.push(`- ${issue}`);
    for (const s of suggestions) lines.push(`- ${s}`);
  }

  return lines.join("\n");
}

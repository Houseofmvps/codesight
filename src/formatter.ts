import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScanResult, KnowledgeMap, KnowledgeNoteType } from "./types.js";

export async function writeOutput(
  result: ScanResult,
  outputDir: string
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  // Compute CRUD groups before formatting
  if (result.crudGroups === undefined) {
    result.crudGroups = computeCrudGroups(result.routes);
  }

  const sections: { name: string; content: string }[] = [];

  if (result.routes.length > 0) {
    const content = formatRoutes(result);
    sections.push({ name: "routes", content });
    await writeFile(join(outputDir, "routes.md"), content);
  }

  if (result.schemas.length > 0) {
    const content = formatSchema(result);
    sections.push({ name: "schema", content });
    await writeFile(join(outputDir, "schema.md"), content);
  }

  if (result.components.length > 0) {
    const content = formatComponents(result);
    sections.push({ name: "components", content });
    await writeFile(join(outputDir, "components.md"), content);
  }

  if (result.libs.length > 0) {
    const content = formatLibs(result);
    sections.push({ name: "libs", content });
    await writeFile(join(outputDir, "libs.md"), content);
  }

  const configContent = formatConfig(result);
  if (configContent) {
    sections.push({ name: "config", content: configContent });
    await writeFile(join(outputDir, "config.md"), configContent);
  }

  if (result.middleware.length > 0) {
    const content = formatMiddleware(result);
    sections.push({ name: "middleware", content });
    await writeFile(join(outputDir, "middleware.md"), content);
  }

  if (result.graph.hotFiles.length > 0) {
    const content = formatGraph(result);
    sections.push({ name: "graph", content });
    await writeFile(join(outputDir, "graph.md"), content);
  }

  if (result.events && result.events.length > 0) {
    const content = formatEvents(result);
    sections.push({ name: "events", content });
    await writeFile(join(outputDir, "events.md"), content);
  }

  if (result.testCoverage && result.testCoverage.testFiles.length > 0) {
    const content = formatCoverage(result);
    sections.push({ name: "coverage", content });
    await writeFile(join(outputDir, "coverage.md"), content);
  }

  const combined = formatCombined(result, sections);
  await writeFile(join(outputDir, "CODESIGHT.md"), combined);

  return combined;
}

function formatRoutes(result: ScanResult): string {
  const lines: string[] = ["# Routes", ""];

  // Separate HTTP routes from special protocols
  const httpRoutes = result.routes.filter(
    (r) => !["QUERY", "MUTATION", "SUBSCRIPTION", "RPC", "WS", "WS-ROOM"].includes(r.method)
  );
  const graphqlRoutes = result.routes.filter((r) =>
    ["QUERY", "MUTATION", "SUBSCRIPTION"].includes(r.method)
  );
  const grpcRoutes = result.routes.filter((r) => r.method === "RPC");
  const wsRoutes = result.routes.filter((r) => r.method === "WS" || r.method === "WS-ROOM");

  // Build set of routes that belong to a CRUD group (to collapse them)
  const crudGroupedPaths = new Set<string>();
  if (result.crudGroups && result.crudGroups.length > 0) {
    for (const group of result.crudGroups) {
      for (const route of httpRoutes) {
        const base = route.path.replace(/\/:[^/]+$/, "").replace(/\/\{[^}]+\}$/, "");
        if (base === group.resource) crudGroupedPaths.add(`${route.method}:${route.path}`);
      }
    }
  }

  // Group HTTP routes by framework
  const byFramework = new Map<string, typeof httpRoutes>();
  for (const route of httpRoutes) {
    const fw = route.framework;
    if (!byFramework.has(fw)) byFramework.set(fw, []);
    byFramework.get(fw)!.push(route);
  }

  // Output CRUD groups summary first
  if (result.crudGroups && result.crudGroups.length > 0) {
    lines.push("## CRUD Resources", "");
    for (const group of result.crudGroups) {
      const modelStr = group.modelHint ? ` → ${group.modelHint}` : "";
      lines.push(`- **\`${group.resource}\`** ${group.methods.join(" | ")}${modelStr}`);
    }
    lines.push("");
  }

  // Output remaining non-CRUD HTTP routes
  const hasNonCrud = Array.from(byFramework.values()).some((routes) =>
    routes.some((r) => !crudGroupedPaths.has(`${r.method}:${r.path}`))
  );

  if (hasNonCrud) {
    if (result.crudGroups && result.crudGroups.length > 0) {
      lines.push("## Other Routes", "");
    }

    for (const [fw, routes] of byFramework) {
      const nonCrud = routes.filter((r) => !crudGroupedPaths.has(`${r.method}:${r.path}`));
      if (nonCrud.length === 0) continue;

      if (byFramework.size > 1) lines.push(`### ${fw}`, "");

      for (const route of nonCrud) {
        const testMark = result.testCoverage?.testedRoutes.includes(`${route.method}:${route.path}`) ? " ✓" : "";
        const tags = route.tags.length > 0 ? ` [${route.tags.join(", ")}]` : "";
        const params = route.params ? ` params(${route.params.join(", ")})` : "";
        const inferred = route.confidence === "regex" ? " `[inferred]`" : "";
        const contract: string[] = [];
        if (route.requestType) contract.push(`in: ${route.requestType}`);
        if (route.responseType) contract.push(`out: ${route.responseType}`);
        const contractStr = contract.length > 0 ? ` → ${contract.join(", ")}` : "";
        lines.push(`- \`${route.method}\` \`${route.path}\`${params}${contractStr}${tags}${inferred}${testMark}`);
      }
      lines.push("");
    }
  }

  // GraphQL operations
  if (graphqlRoutes.length > 0) {
    lines.push("## GraphQL", "");
    const byType = new Map<string, typeof graphqlRoutes>();
    for (const r of graphqlRoutes) {
      if (!byType.has(r.method)) byType.set(r.method, []);
      byType.get(r.method)!.push(r);
    }
    for (const [method, ops] of byType) {
      lines.push(`### ${method}`);
      for (const op of ops) {
        const contract: string[] = [];
        if (op.requestType) contract.push(`in: ${op.requestType}`);
        if (op.responseType) contract.push(`out: ${op.responseType}`);
        const contractStr = contract.length > 0 ? ` → ${contract.join(", ")}` : "";
        lines.push(`- \`${op.path}\`${contractStr}`);
      }
      lines.push("");
    }
  }

  // gRPC
  if (grpcRoutes.length > 0) {
    lines.push("## gRPC", "");
    for (const r of grpcRoutes) {
      const contract = r.requestType && r.responseType ? ` (${r.requestType}) → ${r.responseType}` : "";
      lines.push(`- \`${r.path}\`${contract}`);
    }
    lines.push("");
  }

  // WebSocket events
  if (wsRoutes.length > 0) {
    lines.push("## WebSocket Events", "");
    for (const r of wsRoutes) {
      lines.push(`- \`${r.method}\` \`${r.path}\` — \`${r.file}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatSchema(result: ScanResult): string {
  const lines: string[] = ["# Schema", ""];

  const byOrm = new Map<string, typeof result.schemas>();
  for (const model of result.schemas) {
    if (!byOrm.has(model.orm)) byOrm.set(model.orm, []);
    byOrm.get(model.orm)!.push(model);
  }

  for (const [orm, models] of byOrm) {
    if (byOrm.size > 1) lines.push(`## ${orm}`, "");

    for (const model of models) {
      if (model.name.startsWith("enum:")) {
        const enumName = model.name.replace("enum:", "");
        const values = model.fields.map((f) => f.name).join(" | ");
        lines.push(`### enum ${enumName}: ${values}`, "");
        continue;
      }

      lines.push(`### ${model.name}`);
      for (const field of model.fields) {
        const flags = field.flags.length > 0 ? ` (${field.flags.join(", ")})` : "";
        lines.push(`- ${field.name}: ${field.type}${flags}`);
      }
      if (model.relations.length > 0) {
        lines.push(`- _relations_: ${model.relations.join(", ")}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function formatComponents(result: ScanResult): string {
  const lines: string[] = ["# Components", ""];

  for (const comp of result.components) {
    const markers: string[] = [];
    if (comp.isClient) markers.push("client");
    if (comp.isServer) markers.push("server");
    const markerStr = markers.length > 0 ? ` [${markers.join(", ")}]` : "";

    if (comp.props.length > 0) {
      lines.push(`- **${comp.name}**${markerStr} — props: ${comp.props.join(", ")} — \`${comp.file}\``);
    } else {
      lines.push(`- **${comp.name}**${markerStr} — \`${comp.file}\``);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function formatLibs(result: ScanResult): string {
  const lines: string[] = ["# Libraries", ""];

  for (const lib of result.libs) {
    const maxExports = 6;
    const shown = lib.exports.slice(0, maxExports);
    const remaining = lib.exports.length - maxExports;

    if (lib.exports.length <= 2) {
      const exps = shown
        .map((e) => {
          const sig = e.signature ? `: ${e.signature}` : "";
          return `${e.kind} ${e.name}${sig}`;
        })
        .join(", ");
      lines.push(`- \`${lib.file}\` — ${exps}`);
    } else {
      lines.push(`- \`${lib.file}\``);
      for (const exp of shown) {
        const sig = exp.signature ? `: ${exp.signature}` : "";
        lines.push(`  - ${exp.kind} ${exp.name}${sig}`);
      }
      if (remaining > 0) lines.push(`  - _...${remaining} more_`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function formatConfig(result: ScanResult): string | null {
  const lines: string[] = ["# Config", ""];

  if (result.config.envVars.length > 0) {
    lines.push("## Environment Variables", "");
    for (const env of result.config.envVars) {
      const status = env.hasDefault ? "(has default)" : "**required**";
      lines.push(`- \`${env.name}\` ${status} — ${env.source}`);
    }
    lines.push("");
  }

  if (result.config.configFiles.length > 0) {
    lines.push("## Config Files", "");
    for (const f of result.config.configFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push("");
  }

  const notableDeps = filterNotableDeps(result.config.dependencies);
  if (notableDeps.length > 0) {
    lines.push("## Key Dependencies", "");
    for (const [name, version] of notableDeps) {
      lines.push(`- ${name}: ${version}`);
    }
    lines.push("");
  }

  if (lines.length <= 2) return null;
  return lines.join("\n");
}

function formatMiddleware(result: ScanResult): string {
  const lines: string[] = ["# Middleware", ""];

  const byType = new Map<string, typeof result.middleware>();
  for (const mw of result.middleware) {
    if (!byType.has(mw.type)) byType.set(mw.type, []);
    byType.get(mw.type)!.push(mw);
  }

  for (const [type, mws] of byType) {
    lines.push(`## ${type}`);
    for (const mw of mws) {
      lines.push(`- ${mw.name} — \`${mw.file}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatGraph(result: ScanResult): string {
  const lines: string[] = ["# Dependency Graph", ""];

  lines.push("## Most Imported Files (change these carefully)", "");
  for (const hf of result.graph.hotFiles) {
    lines.push(`- \`${hf.file}\` — imported by **${hf.importedBy}** files`);
  }
  lines.push("");

  // Show top import edges grouped by target
  const edgesByTarget = new Map<string, string[]>();
  for (const edge of result.graph.edges) {
    if (!edgesByTarget.has(edge.to)) edgesByTarget.set(edge.to, []);
    edgesByTarget.get(edge.to)!.push(edge.from);
  }

  const topTargets = Array.from(edgesByTarget.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10);

  if (topTargets.length > 0) {
    lines.push("## Import Map (who imports what)", "");
    for (const [target, importers] of topTargets) {
      const shown = importers.slice(0, 5);
      const more = importers.length > 5 ? ` +${importers.length - 5} more` : "";
      lines.push(`- \`${target}\` ← ${shown.map((i) => `\`${i}\``).join(", ")}${more}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatCombined(
  result: ScanResult,
  sections: { name: string; content: string }[]
): string {
  const lines: string[] = [];

  lines.push(`# ${result.project.name} — AI Context Map`);
  lines.push("");

  const fw = result.project.frameworks.join(", ") || "unknown";
  const orm = result.project.orms.join(", ") || "none";
  const lang = result.project.language;
  const compFw = result.project.componentFramework;

  lines.push(`> **Stack:** ${fw} | ${orm} | ${compFw} | ${lang}`);
  if (result.project.isMonorepo) {
    const wsNames = result.project.workspaces.map((w) => w.name).join(", ");
    const repoLabel = result.project.repoType === "meta" ? "Meta-repo"
      : result.project.repoType === "microservices" ? "Microservices"
      : "Monorepo";
    lines.push(`> **${repoLabel}:** ${wsNames}`);
  }
  lines.push("");

  // Token stats
  const ts = result.tokenStats;
  const httpRouteCount = result.routes.filter(
    (r) => !["QUERY", "MUTATION", "SUBSCRIPTION", "RPC", "WS", "WS-ROOM"].includes(r.method)
  ).length;
  const gqlCount = result.routes.filter((r) => ["QUERY", "MUTATION", "SUBSCRIPTION"].includes(r.method)).length;
  const wsCount = result.routes.filter((r) => r.method === "WS" || r.method === "WS-ROOM").length;
  const grpcCount = result.routes.filter((r) => r.method === "RPC").length;
  const eventCount = result.events?.length ?? 0;
  const coveragePct = result.testCoverage?.coveragePercent;

  const inferredCount = result.routes.filter(r => r.confidence === "regex").length;
  const inferredNote = inferredCount > 0 ? ` (${inferredCount} inferred)` : "";
  let routeStr = `${httpRouteCount} routes${inferredNote}`;
  if (gqlCount > 0) routeStr += ` + ${gqlCount} graphql`;
  if (grpcCount > 0) routeStr += ` + ${grpcCount} rpc`;
  if (wsCount > 0) routeStr += ` + ${wsCount} ws`;

  let extras = "";
  if (eventCount > 0) extras += ` | ${eventCount} events`;
  if (coveragePct !== undefined) extras += ` | ${coveragePct}% test coverage`;

  lines.push(
    `> ${routeStr} | ${result.schemas.length} models | ${result.components.length} components | ${result.libs.length} lib files | ${result.config.envVars.length} env vars | ${result.middleware.length} middleware${extras}`
  );
  // Round to nearest 100 to keep output deterministic across runs (avoids git conflicts in worktrees)
  const roundTo100 = (n: number) => Math.round(n / 100) * 100;
  lines.push(`> **Token savings:** this file is ~${roundTo100(ts.outputTokens).toLocaleString()} tokens. Without it, AI exploration would cost ~${roundTo100(ts.estimatedExplorationTokens).toLocaleString()} tokens. **Saves ~${roundTo100(ts.saved).toLocaleString()} tokens per conversation.**`);
  const scanTime = new Date().toISOString().slice(0, 16).replace("T", " ");
  lines.push(`> **Last scanned:** ${scanTime} — re-run after significant changes`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const section of sections) {
    lines.push(section.content);
    lines.push("---");
    lines.push("");
  }

  lines.push(
    `_Generated by [codesight](https://github.com/Houseofmvps/codesight) — see your codebase clearly_`
  );

  return lines.join("\n");
}

function filterNotableDeps(deps: Record<string, string>): [string, string][] {
  const notable = new Set([
    // Frameworks
    "next", "react", "vue", "svelte", "hono", "express", "fastify", "koa",
    "@nestjs/core", "@nestjs/common", "elysia", "@adonisjs/core",
    "@sveltejs/kit", "@remix-run/node", "@remix-run/react", "nuxt",
    // ORMs & DB
    "drizzle-orm", "prisma", "@prisma/client", "typeorm", "mongoose", "sequelize",
    "pg", "mysql2", "better-sqlite3", "knex",
    // Auth
    "better-auth", "@clerk/nextjs", "next-auth", "lucia", "passport", "@auth/core",
    // Payments
    "stripe", "@polar-sh/sdk", "resend", "@lemonsqueezy/lemonsqueezy.js",
    // Infrastructure
    "bullmq", "redis", "ioredis", "tailwindcss",
    // API
    "zod", "@trpc/server", "graphql", "@apollo/server",
    // AI
    "@anthropic-ai/sdk", "openai", "ai", "langchain", "@google/generative-ai",
    // Services
    "supabase", "@supabase/supabase-js", "firebase", "@firebase/app",
    // Testing/tools
    "playwright", "puppeteer", "socket.io",
  ]);

  return Object.entries(deps)
    .filter(([name]) => notable.has(name))
    .sort(([a], [b]) => a.localeCompare(b));
}

// --- Events / Queues ---
function formatEvents(result: ScanResult): string {
  const events = result.events;
  if (!events || events.length === 0) return "";

  const lines: string[] = ["# Events & Queues", ""];

  const bySystem = new Map<string, typeof events>();
  for (const e of events) {
    if (!bySystem.has(e.system)) bySystem.set(e.system, []);
    bySystem.get(e.system)!.push(e);
  }

  for (const [system, items] of bySystem) {
    if (bySystem.size > 1) lines.push(`## ${system}`, "");
    for (const item of items) {
      const payload = item.payloadType ? ` → ${item.payloadType}` : "";
      lines.push(`- \`${item.name}\` [${item.type}]${payload} — \`${item.file}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// --- Test Coverage ---
function formatCoverage(result: ScanResult): string {
  const cov = result.testCoverage;
  if (!cov || cov.testFiles.length === 0) return "";

  const lines: string[] = ["# Test Coverage", ""];

  lines.push(`> **${cov.coveragePercent}%** of routes and models are covered by tests`);
  lines.push(`> ${cov.testFiles.length} test files found`);
  lines.push("");

  if (cov.testedRoutes.length > 0) {
    lines.push("## Covered Routes", "");
    for (const r of cov.testedRoutes) {
      lines.push(`- ${r}`);
    }
    lines.push("");
  }

  if (cov.testedModels.length > 0) {
    lines.push("## Covered Models", "");
    for (const m of cov.testedModels) {
      lines.push(`- ${m}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// --- CRUD group computation ---
/**
 * Detect standard CRUD groups: same resource base path with GET, POST,
 * GET/:id, PUT/:id, DELETE/:id — collapse to a summary line in routes output.
 */
export function computeCrudGroups(routes: ScanResult["routes"]): import("./types.js").CrudGroup[] {
  const httpRoutes = routes.filter(
    (r) => !["QUERY", "MUTATION", "SUBSCRIPTION", "RPC", "WS", "WS-ROOM"].includes(r.method)
  );

  // Group by base resource — strip trailing :id or :param
  const byBase = new Map<string, typeof httpRoutes>();
  for (const route of httpRoutes) {
    const base = route.path.replace(/\/:[^/]+$/, "").replace(/\/\{[^}]+\}$/, "");
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base)!.push(route);
  }

  const groups: import("./types.js").CrudGroup[] = [];

  for (const [base, groupRoutes] of byBase) {
    const methods = new Set(groupRoutes.map((r) => r.method));
    const hasList = methods.has("GET") && groupRoutes.some((r) => r.path === base);
    const hasCreate = methods.has("POST");
    const hasGet = methods.has("GET") && groupRoutes.some((r) => r.path !== base);
    const hasUpdate = methods.has("PUT") || methods.has("PATCH");
    const hasDelete = methods.has("DELETE");

    const crudCount = [hasList, hasCreate, hasGet, hasUpdate, hasDelete].filter(Boolean).length;

    if (crudCount >= 3 && groupRoutes.length >= 3) {
      const methodLabels: string[] = [];
      if (hasList) methodLabels.push("GET");
      if (hasCreate) methodLabels.push("POST");
      if (hasGet) methodLabels.push("GET/:id");
      if (hasUpdate) methodLabels.push(methods.has("PUT") ? "PUT/:id" : "PATCH/:id");
      if (hasDelete) methodLabels.push("DELETE/:id");

      // Guess model name from base path
      const segments = base.split("/").filter(Boolean);
      const lastSegment = segments[segments.length - 1] || "";
      const modelHint = lastSegment.charAt(0).toUpperCase() +
        lastSegment.slice(1).replace(/s$/, ""); // naive depluralize

      groups.push({
        resource: base,
        methods: methodLabels,
        modelHint,
      });
    }
  }

  return groups;
}

// ─── Knowledge Formatter ──────────────────────────────────────────────────────

const NOTE_TYPE_LABELS: Record<KnowledgeNoteType, string> = {
  decision: "Decision Records",
  meeting: "Meeting Notes",
  retro: "Retrospectives",
  spec: "Specs & PRDs",
  backlog: "Backlogs",
  research: "Research",
  session: "Session Logs",
  general: "General Notes",
};

export function formatKnowledge(map: KnowledgeMap, projectName: string, version: string): string {
  const lines: string[] = [];
  const { notes, decisions, openQuestions, recurringThemes, people, projects, dateRange, hubNotes } = map;

  const dateStr = dateRange ? ` · ${dateRange.from} → ${dateRange.to}` : "";
  lines.push(`# Knowledge Map — ${projectName}`);
  lines.push(`> ${notes.length} notes · ${decisions.length} decisions · ${openQuestions.length} open questions${dateStr}`);
  lines.push("");

  // AI Context Primer — synthesized summary for pasting into any AI conversation
  {
    const parts: string[] = [];
    const topThemes = recurringThemes.slice(0, 4).join(", ");
    const topDecision = decisions[0] ? decisions[0].replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, "") : null;
    const noteWord = notes.length === 1 ? "note" : "notes";
    if (dateRange) {
      parts.push(`This knowledge base spans ${dateRange.from} to ${dateRange.to} (${notes.length} ${noteWord}).`);
    } else {
      parts.push(`This knowledge base has ${notes.length} ${noteWord}.`);
    }
    if (topThemes) parts.push(`Key topics: ${topThemes}.`);
    if (topDecision) {
      const d = topDecision.length > 120 ? topDecision.slice(0, 120) + "…" : topDecision;
      parts.push(`Most recent decision: ${d.replace(/\.+$/, "")}.`);
    }
    if (openQuestions.length > 0) parts.push(`${openQuestions.length} open question${openQuestions.length > 1 ? "s" : ""} remain.`);
    lines.push(`> **AI Primer:** ${parts.join(" ")}`);
    lines.push("");
  }

  // Key decisions (most recent first, already sorted)
  if (decisions.length > 0) {
    lines.push(`## Key Decisions (${decisions.length})`);
    for (const d of decisions) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  // Open questions
  if (openQuestions.length > 0) {
    lines.push(`## Open Questions (${openQuestions.length})`);
    for (const q of openQuestions) {
      lines.push(`- ${q}`);
    }
    lines.push("");
  }

  // Projects
  if (projects.length > 0) {
    lines.push(`## Projects`);
    lines.push(projects.map((p) => `\`${p}\``).join(" · "));
    lines.push("");
  }

  // Recurring themes
  if (recurringThemes.length > 0) {
    lines.push(`## Recurring Themes`);
    lines.push(recurringThemes.join(" · "));
    lines.push("");
  }

  // People — handles get @prefix, full names shown as-is
  if (people.length > 0) {
    lines.push(`## People`);
    lines.push(people.map((p) => p.includes(" ") ? p : `@${p}`).join(" · "));
    lines.push("");
  }

  // Hub Notes — most referenced notes (the "important" ones in the knowledge graph)
  if (hubNotes && hubNotes.length > 0) {
    lines.push(`## Hub Notes (most referenced)`);
    for (const hub of hubNotes) {
      lines.push(`- \`${hub.file}\` — **${hub.refs}** incoming references — ${hub.title}`);
    }
    lines.push("");
  }

  // Note index grouped by type
  const byType = new Map<KnowledgeNoteType, typeof notes>();
  for (const note of notes) {
    if (!byType.has(note.type)) byType.set(note.type, []);
    byType.get(note.type)!.push(note);
  }

  const typeOrder: KnowledgeNoteType[] = ["decision", "spec", "retro", "meeting", "research", "session", "backlog", "general"];
  lines.push(`## Note Index (${notes.length})`);
  for (const type of typeOrder) {
    const group = byType.get(type);
    if (!group || group.length === 0) continue;
    lines.push(`\n### ${NOTE_TYPE_LABELS[type]} (${group.length})`);
    for (const note of group.slice(0, 20)) {
      const date = note.date ? ` — ${note.date}` : "";
      const refs = note.backlinks ? ` ← ${note.backlinks} refs` : "";
      const summary = note.summary ? ` — ${note.summary}` : "";
      const display = `\`${note.file}\`${date}${refs}${summary}`;
      lines.push(`- ${display}`);
    }
    if (group.length > 20) lines.push(`- _…and ${group.length - 20} more_`);
  }

  lines.push("");
  lines.push("---");
  lines.push(`_Generated by [codesight](https://github.com/Houseofmvps/codesight) v${version}_`);

  return lines.join("\n");
}

export async function writeKnowledgeOutput(
  map: KnowledgeMap,
  outputDir: string,
  projectName: string,
  version: string
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const content = formatKnowledge(map, projectName, version);
  await writeFile(join(outputDir, "KNOWLEDGE.md"), content);
  return content;
}

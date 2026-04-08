import { resolve, join } from "node:path";
import { collectFiles, detectProject } from "./scanner.js";
import { loadConfig } from "./config.js";
import { detectRoutes } from "./detectors/routes.js";
import { detectSchemas } from "./detectors/schema.js";
import { detectComponents } from "./detectors/components.js";
import { detectLibs } from "./detectors/libs.js";
import { detectConfig } from "./detectors/config.js";
import { detectMiddleware } from "./detectors/middleware.js";
import { detectDependencyGraph } from "./detectors/graph.js";
import { enrichRouteContracts } from "./detectors/contracts.js";
import { calculateTokenStats } from "./detectors/tokens.js";
import { writeOutput } from "./formatter.js";
import { analyzeBlastRadius, analyzeMultiFileBlastRadius } from "./detectors/blast-radius.js";
import { readWikiArticle, listWikiArticles, lintWiki } from "./generators/wiki.js";
import type { ScanResult } from "./types.js";

/**
 * MCP server with 8 specialized tools for AI assistants.
 * Zero dependencies — raw JSON-RPC 2.0 over stdio.
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

function send(msg: JsonRpcResponse) {
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
  process.stdout.write(header + json);
}

// Cache scan results for the session to avoid re-scanning
let cachedResult: ScanResult | null = null;
let cachedRoot: string | null = null;

async function getScanResult(directory?: string): Promise<ScanResult> {
  const root = resolve(directory || process.cwd());

  // Return cached if same directory
  if (cachedResult && cachedRoot === root) return cachedResult;

  const project = await detectProject(root);
  const userConfig = await loadConfig(root);
  const files = await collectFiles(root, userConfig.maxDepth ?? 10, userConfig.ignorePatterns ?? []);

  const [rawRoutes, schemas, components, libs, config, middleware, graph] =
    await Promise.all([
      detectRoutes(files, project),
      detectSchemas(files, project),
      detectComponents(files, project),
      detectLibs(files, project),
      detectConfig(files, project),
      detectMiddleware(files, project),
      detectDependencyGraph(files, project),
    ]);

  const routes = await enrichRouteContracts(rawRoutes, project);

  const tempResult: ScanResult = {
    project,
    routes,
    schemas,
    components,
    libs,
    config,
    middleware,
    graph,
    tokenStats: { outputTokens: 0, estimatedExplorationTokens: 0, saved: 0, fileCount: files.length },
  };

  const outputContent = await writeOutput(tempResult, resolve(root, ".codesight"));
  const tokenStats = calculateTokenStats(tempResult, outputContent, files.length);

  cachedResult = { ...tempResult, tokenStats };
  cachedRoot = root;
  return cachedResult;
}

// =================== TOOL IMPLEMENTATIONS ===================

async function toolScan(args: any): Promise<string> {
  const result = await getScanResult(args.directory);
  const outputContent = await writeOutput(result, resolve(cachedRoot!, ".codesight"));
  return outputContent.replace(
    /Saves ~\d[\d,]* tokens/,
    `Saves ~${result.tokenStats.saved.toLocaleString()} tokens`
  );
}

async function toolGetRoutes(args: any): Promise<string> {
  const result = await getScanResult(args.directory);
  let routes = result.routes;

  // Filter by prefix
  if (args.prefix) {
    routes = routes.filter((r) => r.path.startsWith(args.prefix));
  }
  // Filter by tag
  if (args.tag) {
    routes = routes.filter((r) => r.tags.includes(args.tag));
  }
  // Filter by method
  if (args.method) {
    routes = routes.filter((r) => r.method === args.method.toUpperCase());
  }

  const lines = routes.map((r) => {
    const tags = r.tags.length > 0 ? ` [${r.tags.join(", ")}]` : "";
    const params = r.params ? ` params(${r.params.join(", ")})` : "";
    return `${r.method} ${r.path}${params}${tags} — ${r.file}`;
  });

  return lines.length > 0
    ? `${lines.length} routes:\n${lines.join("\n")}`
    : "No routes found matching filters.";
}

async function toolGetSchema(args: any): Promise<string> {
  const result = await getScanResult(args.directory);
  let models = result.schemas;

  if (args.model) {
    models = models.filter((m) => m.name.toLowerCase().includes(args.model.toLowerCase()));
  }

  const lines: string[] = [];
  for (const model of models) {
    lines.push(`### ${model.name} (${model.orm})`);
    for (const field of model.fields) {
      const flags = field.flags.length > 0 ? ` (${field.flags.join(", ")})` : "";
      lines.push(`  ${field.name}: ${field.type}${flags}`);
    }
    if (model.relations.length > 0) {
      lines.push(`  relations: ${model.relations.join(", ")}`);
    }
    lines.push("");
  }

  return lines.length > 0
    ? `${models.length} models:\n${lines.join("\n")}`
    : "No models found.";
}

async function toolGetBlastRadius(args: any): Promise<string> {
  const result = await getScanResult(args.directory);
  const maxDepth = args.depth || 3;

  let br;
  if (args.files && Array.isArray(args.files)) {
    br = analyzeMultiFileBlastRadius(args.files, result, maxDepth);
  } else if (args.file) {
    br = analyzeBlastRadius(args.file, result, maxDepth);
  } else {
    return "Error: provide 'file' (string) or 'files' (array) parameter.";
  }

  const lines: string[] = [];
  lines.push(`## Blast Radius for ${br.file}`);
  lines.push(`Depth: ${br.depth} hops\n`);

  if (br.affectedFiles.length > 0) {
    lines.push(`### Affected Files (${br.affectedFiles.length})`);
    for (const f of br.affectedFiles.slice(0, 30)) {
      lines.push(`- ${f}`);
    }
    if (br.affectedFiles.length > 30) {
      lines.push(`- ... +${br.affectedFiles.length - 30} more`);
    }
    lines.push("");
  }

  if (br.affectedRoutes.length > 0) {
    lines.push(`### Affected Routes (${br.affectedRoutes.length})`);
    for (const r of br.affectedRoutes) {
      lines.push(`- ${r.method} ${r.path} — ${r.file}`);
    }
    lines.push("");
  }

  if (br.affectedModels.length > 0) {
    lines.push(`### Potentially Affected Models (${br.affectedModels.length})`);
    for (const m of br.affectedModels) {
      lines.push(`- ${m}`);
    }
    lines.push("");
  }

  if (br.affectedMiddleware.length > 0) {
    lines.push(`### Affected Middleware (${br.affectedMiddleware.length})`);
    for (const m of br.affectedMiddleware) {
      lines.push(`- ${m}`);
    }
    lines.push("");
  }

  if (br.affectedFiles.length === 0 && br.affectedRoutes.length === 0) {
    lines.push("No downstream dependencies found. This file change has minimal blast radius.");
  }

  return lines.join("\n");
}

async function toolGetEnv(args: any): Promise<string> {
  const result = await getScanResult(args.directory);
  const envVars = result.config.envVars;

  if (args.required_only) {
    const required = envVars.filter((e) => !e.hasDefault);
    const lines = required.map((e) => `${e.name} **required** — ${e.source}`);
    return `${required.length} required env vars (no defaults):\n${lines.join("\n")}`;
  }

  const lines = envVars.map((e) => {
    const status = e.hasDefault ? "(has default)" : "**required**";
    return `${e.name} ${status} — ${e.source}`;
  });

  return `${envVars.length} env vars:\n${lines.join("\n")}`;
}

async function toolGetHotFiles(args: any): Promise<string> {
  const result = await getScanResult(args.directory);
  const limit = args.limit || 15;
  const hotFiles = result.graph.hotFiles.slice(0, limit);

  if (hotFiles.length === 0) return "No import graph data. Run a full scan first.";

  const lines = hotFiles.map((h) =>
    `${h.file} — imported by ${h.importedBy} files`
  );

  return `Top ${hotFiles.length} most-imported files (change carefully):\n${lines.join("\n")}`;
}

async function toolGetSummary(args: any): Promise<string> {
  const result = await getScanResult(args.directory);
  const { project, routes, schemas, components, config, middleware, graph, tokenStats } = result;

  const fw = project.frameworks.join(", ") || "generic";
  const orm = project.orms.join(", ") || "none";

  const lines: string[] = [];
  lines.push(`# ${project.name}`);
  lines.push(`Stack: ${fw} | ${orm} | ${project.componentFramework} | ${project.language}`);
  if (project.isMonorepo) {
    lines.push(`Monorepo: ${project.workspaces.map((w) => w.name).join(", ")}`);
  }
  lines.push("");
  lines.push(`${routes.length} routes | ${schemas.length} models | ${components.length} components | ${config.envVars.length} env vars | ${middleware.length} middleware | ${graph.edges.length} import links`);
  lines.push(`Token savings: ~${tokenStats.saved.toLocaleString()} per conversation`);
  lines.push("");

  // Top routes summary
  if (routes.length > 0) {
    lines.push(`Key API areas: ${[...new Set(routes.map((r) => r.path.split("/").slice(0, 3).join("/")))].slice(0, 8).join(", ")}`);
  }

  // Hot files
  if (graph.hotFiles.length > 0) {
    lines.push(`High-impact files: ${graph.hotFiles.slice(0, 5).map((h) => h.file).join(", ")}`);
  }

  // Required env
  const required = config.envVars.filter((e) => !e.hasDefault);
  if (required.length > 0) {
    lines.push(`Required env: ${required.slice(0, 8).map((e) => e.name).join(", ")}${required.length > 8 ? ` +${required.length - 8} more` : ""}`);
  }

  lines.push("");
  lines.push("Use codesight_get_routes, codesight_get_schema, codesight_get_blast_radius for details.");

  return lines.join("\n");
}

async function toolRefresh(args: any): Promise<string> {
  cachedResult = null;
  cachedRoot = null;
  const result = await getScanResult(args.directory);
  return `Refreshed. ${result.routes.length} routes, ${result.schemas.length} models, ${result.graph.edges.length} import links, ${result.config.envVars.length} env vars.`;
}

async function toolGetWikiIndex(args: any): Promise<string> {
  const result = await getScanResult(args.directory);
  const outputDir = join(cachedRoot!, ".codesight");
  const index = await readWikiArticle(outputDir, "index");
  if (index) return index;

  // Wiki not generated yet — return a summary pointing to --wiki
  return `Wiki not generated yet. Run \`npx codesight --wiki\` to generate the knowledge base.\n\nFor now, use codesight_get_summary for a quick overview.\n\nProject: ${result.project.name} | ${result.routes.length} routes | ${result.schemas.length} models`;
}

async function toolGetWikiArticle(args: any): Promise<string> {
  if (!args.article) return "Error: provide 'article' parameter (e.g., 'overview', 'auth', 'database', 'payments')";
  await getScanResult(args.directory);
  const outputDir = join(cachedRoot!, ".codesight");

  const content = await readWikiArticle(outputDir, args.article);
  if (content) return content;

  // Article not found — list available ones
  const available = await listWikiArticles(outputDir);
  if (available.length === 0) {
    return `Wiki not generated. Run \`npx codesight --wiki\` first.\nAvailable articles will include: overview, database, auth, payments, and one per API domain.`;
  }
  return `Article '${args.article}' not found.\nAvailable articles: ${available.join(", ")}`;
}

async function toolLintWiki(args: any): Promise<string> {
  const result = await getScanResult(args.directory);
  const outputDir = join(cachedRoot!, ".codesight");
  return lintWiki(result, outputDir);
}

// =================== TOOL DEFINITIONS ===================

const TOOLS = [
  {
    name: "codesight_scan",
    description:
      "Full codebase scan. Returns complete AI context map with routes, schema, components, libraries, config, middleware, and dependency graph. Use this for initial project understanding.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory to scan (defaults to cwd)" },
      },
    },
    handler: toolScan,
  },
  {
    name: "codesight_get_summary",
    description:
      "Compact project summary (~500 tokens). Stack, key stats, high-impact files, required env vars. Use this first before diving deeper.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory (defaults to cwd)" },
      },
    },
    handler: toolGetSummary,
  },
  {
    name: "codesight_get_routes",
    description:
      "Get API routes with methods, paths, params, tags, and handler files. Supports filtering by prefix, tag, or HTTP method.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory (defaults to cwd)" },
        prefix: { type: "string", description: "Filter routes by path prefix (e.g., '/api/users')" },
        tag: { type: "string", description: "Filter routes by tag (e.g., 'auth', 'db', 'payment', 'ai')" },
        method: { type: "string", description: "Filter by HTTP method (e.g., 'GET', 'POST')" },
      },
    },
    handler: toolGetRoutes,
  },
  {
    name: "codesight_get_schema",
    description:
      "Get database models with fields, types, constraints, and relations. Optionally filter by model name.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory (defaults to cwd)" },
        model: { type: "string", description: "Filter by model name (partial match)" },
      },
    },
    handler: toolGetSchema,
  },
  {
    name: "codesight_get_blast_radius",
    description:
      "Blast radius analysis. Given a file (or list of files), returns all transitively affected files, routes, models, and middleware. Use before making changes to understand impact.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory (defaults to cwd)" },
        file: { type: "string", description: "Single file path (relative to project root)" },
        files: { type: "array", items: { type: "string" }, description: "Multiple file paths for combined blast radius" },
        depth: { type: "number", description: "Max traversal depth (default: 3)" },
      },
    },
    handler: toolGetBlastRadius,
  },
  {
    name: "codesight_get_env",
    description:
      "Get environment variables across the codebase with required/default status and source file.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory (defaults to cwd)" },
        required_only: { type: "boolean", description: "Only show required vars (no defaults)" },
      },
    },
    handler: toolGetEnv,
  },
  {
    name: "codesight_get_hot_files",
    description:
      "Get the most-imported files in the project. These have the highest blast radius — changes here affect the most other files.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory (defaults to cwd)" },
        limit: { type: "number", description: "Number of files to return (default: 15)" },
      },
    },
    handler: toolGetHotFiles,
  },
  {
    name: "codesight_refresh",
    description:
      "Force re-scan the project. Use after making significant changes to get updated context.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory (defaults to cwd)" },
      },
    },
    handler: toolRefresh,
  },
  {
    name: "codesight_get_wiki_index",
    description:
      "Get the wiki index (~200 tokens). Lists all available wiki articles with one-line summaries. Read this at session start for instant project orientation. If wiki not generated, run `npx codesight --wiki` first.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory (defaults to cwd)" },
      },
    },
    handler: toolGetWikiIndex,
  },
  {
    name: "codesight_get_wiki_article",
    description:
      "Read a specific wiki article by name. Each article covers one subsystem in narrative form (~300-500 tokens). Use for targeted questions: 'how does auth work?' → article='auth', 'what models exist?' → article='database', 'what routes are there?' → article='api'. Much cheaper than loading the full context map.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory (defaults to cwd)" },
        article: {
          type: "string",
          description:
            "Article name without .md extension (e.g. 'overview', 'auth', 'payments', 'database', 'ui', or any domain name)",
        },
      },
      required: ["article"],
    },
    handler: toolGetWikiArticle,
  },
  {
    name: "codesight_lint_wiki",
    description:
      "Health check the wiki. Finds orphan articles, missing cross-links, and articles that may be stale. Run after making significant changes to verify wiki integrity.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory (defaults to cwd)" },
      },
    },
    handler: toolLintWiki,
  },
];

// =================== MCP PROTOCOL ===================

async function handleRequest(req: JsonRpcRequest) {
  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id ?? null,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "codesight", version: "1.2.0" },
      },
    });
    return;
  }

  if (req.method === "notifications/initialized") {
    return;
  }

  if (req.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: req.id ?? null,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      },
    });
    return;
  }

  if (req.method === "tools/call") {
    const toolName = req.params?.name;
    const args = req.params?.arguments || {};

    const tool = TOOLS.find((t) => t.name === toolName);
    if (tool) {
      try {
        const result = await tool.handler(args);
        send({
          jsonrpc: "2.0",
          id: req.id ?? null,
          result: {
            content: [{ type: "text", text: result }],
          },
        });
      } catch (err: any) {
        send({
          jsonrpc: "2.0",
          id: req.id ?? null,
          result: {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          },
        });
      }
      return;
    }

    send({
      jsonrpc: "2.0",
      id: req.id ?? null,
      error: { code: -32601, message: `Unknown tool: ${toolName}` },
    });
    return;
  }

  if (req.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    });
  }
}

export async function startMCPServer() {
  let buffer = "";
  const messageQueue: JsonRpcRequest[] = [];
  let processing = false;

  async function processQueue() {
    if (processing) return;
    processing = true;
    while (messageQueue.length > 0) {
      const req = messageQueue.shift()!;
      try {
        await handleRequest(req);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
    }
    processing = false;
  }

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;

    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = buffer.substring(0, headerEnd);
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        buffer = buffer.substring(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(lengthMatch[1], 10);
      const bodyStart = headerEnd + 4;

      if (buffer.length < bodyStart + contentLength) break;

      const body = buffer.substring(bodyStart, bodyStart + contentLength);
      buffer = buffer.substring(bodyStart + contentLength);

      try {
        const req = JSON.parse(body) as JsonRpcRequest;
        messageQueue.push(req);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
    }

    processQueue();
  });

  await new Promise(() => {});
}

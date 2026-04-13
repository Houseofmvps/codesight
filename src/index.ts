#!/usr/bin/env node

import { resolve, join } from "node:path";
import { writeFile, stat, mkdir } from "node:fs/promises";
import { collectFiles } from "./scanner.js";
import { writeKnowledgeOutput } from "./formatter.js";
import { detectKnowledge } from "./detectors/knowledge.js";
import { generateAIConfigs } from "./generators/ai-config.js";
import { generateHtmlReport } from "./generators/html-report.js";
import { generateWiki } from "./generators/wiki.js";
import type { ScanResult } from "./types.js";
import type { CodesightConfig } from "./types.js";
import { loadConfig, mergeCliConfig } from "./config.js";
import { scan, BRAND, VERSION } from "./core.js";

function printHelp() {
  console.log(`
  ${BRAND} v${VERSION} — See your codebase clearly

  Usage: ${BRAND} [options] [directory]

  Options:
    -o, --output <dir>       Output directory (default: .codesight)
    -d, --depth <n>          Max directory depth (default: 10)
    --wiki                   Generate wiki knowledge base (.codesight/wiki/)
    --init                   Generate AI config files (CLAUDE.md, .cursorrules, etc.)
    --watch                  Re-scan on file changes
    --hook                   Install git pre-commit hook
    --html                   Generate interactive HTML report
    --open                   Generate HTML report and open in browser
    --mcp                    Start as MCP server (for Claude Code, Cursor)
    --json                   Output JSON instead of markdown
    --benchmark              Show detailed token savings breakdown
    --profile <tool>         Generate optimized config (claude-code|cursor|codex|copilot|windsurf|agents)
    --blast <file>           Show blast radius for a file
    --telemetry              Run token telemetry (real before/after measurement)
    --eval                   Run precision/recall benchmarks on eval fixtures
    --max-tokens <n>         Trim output to fit token budget (e.g. --max-tokens 50000)
    --since <ref>            Show only routes from files changed since git ref/commit
    --mode <mode>            Scan mode: code (default) | knowledge (map .md notes)
    --refresh [pkg]          Rebuild monorepo package context (all or named package)
    -v, --version            Show version
    -h, --help               Show this help

  Config (.codesightignore / codesight.config.json):
    Reads codesight.config.(ts|js|json) or package.json "codesight" field.
    .codesightignore: gitignore-style patterns for files/dirs to skip.
    Detectors: graphql, grpc, websocket, events auto-detected when present.
    See docs for disableDetectors, customRoutePatterns, plugins, maxTokens, and more.

  Examples:
    npx ${BRAND}                         # Scan current directory
    npx ${BRAND} --wiki                  # Scan + generate wiki knowledge base
    npx ${BRAND} --init                  # Scan + generate AI config files
    npx ${BRAND} --open                  # Scan + open visual report
    npx ${BRAND} --watch                 # Watch mode, re-scan on changes
    npx ${BRAND} --mcp                   # Start MCP server
    npx ${BRAND} --hook                  # Install git pre-commit hook
    npx ${BRAND} --max-tokens 50000      # Fit output in 50K token budget
    npx ${BRAND} --since HEAD~5          # Show routes from last 5 commits
    npx ${BRAND} --telemetry             # Measure real token savings
    npx ${BRAND} --eval                  # Run accuracy benchmarks
    npx ${BRAND} ./my-project            # Scan specific directory
    npx ${BRAND} --mode knowledge        # Map knowledge base (.md notes → KNOWLEDGE.md)
    npx ${BRAND} --mode knowledge ~/vault # Map Obsidian vault or any .md folder
    npx ${BRAND} --profile agents        # Generate AGENTS.md only (cross-platform agents)
`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function installGitHook(root: string, outputDirName: string) {
  const hooksDir = join(root, ".git", "hooks");
  const hookPath = join(hooksDir, "pre-commit");

  if (!(await fileExists(join(root, ".git")))) {
    console.log("  No .git directory found. Initialize a git repo first.");
    return;
  }

  await mkdir(hooksDir, { recursive: true });

  let existingContent = "";
  try {
    const { readFile } = await import("node:fs/promises");
    existingContent = await readFile(hookPath, "utf-8");
  } catch {}

  const safeOutputDir = outputDirName.replace(/[^a-zA-Z0-9._-]/g, "");
  const hookCommand = `\n# codesight: regenerate AI context\nnpx codesight --wiki -o ${safeOutputDir}\ngit add ${safeOutputDir}/\n`;

  if (existingContent.includes("codesight")) {
    console.log("  Git hook already installed.");
    return;
  }

  if (existingContent) {
    await writeFile(hookPath, existingContent + hookCommand);
  } else {
    await writeFile(hookPath, `#!/bin/sh\n${hookCommand}`);
  }

  // Make executable
  const { chmod } = await import("node:fs/promises");
  await chmod(hookPath, 0o755);

  console.log(`  Git pre-commit hook installed at .git/hooks/pre-commit`);
}

async function watchMode(root: string, outputDirName: string, maxDepth: number, userConfig: CodesightConfig = {}, wikiMode = false) {
  console.log(`  Watching for changes... (Ctrl+C to stop)\n`);

  const WATCH_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".go", ".vue", ".svelte", ".rb", ".ex", ".exs",
    ".java", ".kt", ".rs", ".php",
    ".json", ".yaml", ".yml", ".toml", ".env",
    ".prisma", ".graphql", ".gql",
  ]);

  const IGNORE_DIRS = new Set([
    "node_modules", ".git", ".next", ".nuxt", ".svelte-kit",
    "__pycache__", ".venv", "venv", "dist", "build", "out",
    ".output", "coverage", ".turbo", ".vercel", ".cache",
    outputDirName,
  ]);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let isScanning = false;
  let changedFiles: string[] = [];

  const runScan = async () => {
    if (isScanning) return;
    isScanning = true;
    const files = [...changedFiles];
    changedFiles = [];
    try {
      const fileList = files.length <= 5 ? files.join(", ") : `${files.length} files`;
      console.log(`\n  Changes detected (${fileList}), re-scanning...\n`);
      const watchResult = await scan(root, outputDirName, maxDepth, userConfig);
      if (wikiMode) {
        process.stdout.write("  Regenerating wiki...");
        const outputDir = join(root, outputDirName);
        const wikiResult = await generateWiki(watchResult, outputDir);
        console.log(` ${wikiResult.articles.length} articles updated`);
      }
    } catch (err: any) {
      console.error("  Scan error:", err.message);
    }
    isScanning = false;
  };

  const { watch } = await import("node:fs");
  const { extname: ext } = await import("node:path");

  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;

    // Skip ignored directories
    const parts = filename.split("/");
    if (parts.some((p) => IGNORE_DIRS.has(p))) return;

    // Only trigger on relevant file extensions
    const fileExt = ext(filename);
    if (!WATCH_EXTENSIONS.has(fileExt)) return;

    changedFiles.push(filename);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runScan, 500);
  });

  process.on("SIGINT", () => {
    watcher.close();
    console.log("\n  Watch mode stopped.");
    process.exit(0);
  });

  await new Promise(() => {});
}

async function runKnowledgeScan(root: string, outputDirName: string, maxDepth: number) {
  const outputDir = join(root, outputDirName);
  const projectName = root.split("/").pop() || "Project";

  console.log(`\n  ${BRAND} v${VERSION}`);
  console.log(`  Knowledge scan: ${root}\n`);

  const startTime = Date.now();

  process.stdout.write("  Collecting notes...");
  const files = await collectFiles(root, maxDepth, []);
  const mdFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".mdx"));
  console.log(` ${mdFiles.length} markdown files`);

  process.stdout.write("  Analyzing...");
  const map = await detectKnowledge(files, root);
  console.log(` done (${map.totalNotes} notes, ${map.decisions.length} decisions, ${map.openQuestions.length} questions)`);

  process.stdout.write("  Writing output...");
  await writeKnowledgeOutput(map, outputDir, projectName, VERSION);
  console.log(` ${outputDirName}/KNOWLEDGE.md`);

  const elapsed = Date.now() - startTime;

  // Note type breakdown
  const typeCounts = new Map<string, number>();
  for (const note of map.notes) {
    typeCounts.set(note.type, (typeCounts.get(note.type) || 0) + 1);
  }
  const breakdown = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}: ${n}`)
    .join(", ");

  console.log(`
  Results:
    Notes:        ${map.totalNotes}
    Decisions:    ${map.decisions.length}
    Questions:    ${map.openQuestions.length}
    Themes:       ${map.recurringThemes.length}
    People:       ${map.people.length}
    ${breakdown ? `Breakdown:    ${breakdown}` : ""}

  Done in ${elapsed}ms
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`${BRAND} v${VERSION}`);
    process.exit(0);
  }

  // Parse args
  let targetDir = process.cwd();
  let outputDirName = ".codesight";
  let maxDepth = 10;
  let jsonOutput = false;
  let doWiki = false;
  let doInit = false;
  let doWatch = false;
  let doHook = false;
  let doHtml = false;
  let doOpen = false;
  let doMcp = false;
  let doBenchmark = false;
  let doProfile = "";
  let doBlast = "";
  let doTelemetry = false;
  let doEval = false;
  let maxTokens = 0;
  let doSince = "";
  let mode = "code";
  let doRefresh = false;
  let refreshPackage = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-o" || arg === "--output") && args[i + 1]) {
      outputDirName = args[++i];
    } else if ((arg === "-d" || arg === "--depth") && args[i + 1]) {
      maxDepth = parseInt(args[++i], 10);
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--wiki") {
      doWiki = true;
    } else if (arg === "--init") {
      doInit = true;
    } else if (arg === "--watch") {
      doWatch = true;
    } else if (arg === "--hook") {
      doHook = true;
    } else if (arg === "--html") {
      doHtml = true;
    } else if (arg === "--open") {
      doHtml = true;
      doOpen = true;
    } else if (arg === "--mcp") {
      doMcp = true;
    } else if (arg === "--benchmark") {
      doBenchmark = true;
    } else if (arg === "--profile" && args[i + 1]) {
      doProfile = args[++i];
    } else if (arg === "--blast" && args[i + 1]) {
      doBlast = args[++i];
    } else if (arg === "--telemetry") {
      doTelemetry = true;
    } else if (arg === "--eval") {
      doEval = true;
    } else if (arg === "--max-tokens" && args[i + 1]) {
      maxTokens = parseInt(args[++i], 10);
    } else if (arg === "--since" && args[i + 1]) {
      doSince = args[++i];
    } else if (arg === "--mode" && args[i + 1]) {
      mode = args[++i];
    } else if (arg === "--refresh") {
      doRefresh = true;
      if (args[i + 1] && !args[i + 1].startsWith("-")) {
        refreshPackage = args[++i];
      }
    } else if (!arg.startsWith("-")) {
      targetDir = resolve(arg);
    }
  }

  // MCP server mode (blocks, no other output)
  if (doMcp) {
    const { startMCPServer } = await import("./mcp-server.js");
    await startMCPServer();
    return;
  }

  // Eval mode (standalone, no scan needed)
  if (doEval) {
    const { runEval } = await import("./eval.js");
    await runEval();
    return;
  }

  const root = resolve(targetDir);

  // Load config file
  const fileConfig = await loadConfig(root);
  const config = mergeCliConfig(fileConfig, {
    maxDepth: maxDepth !== 10 ? maxDepth : undefined,
    outputDir: outputDirName !== ".codesight" ? outputDirName : undefined,
    profile: doProfile || undefined,
    maxTokens: maxTokens > 0 ? maxTokens : undefined,
  });

  // Apply config overrides
  if (config.maxDepth) maxDepth = config.maxDepth;
  if (config.outputDir) outputDirName = config.outputDir;

  // --since: get list of files changed since a git ref
  let sinceFiles: Set<string> | null = null;
  if (doSince) {
    try {
      const { execFileSync } = await import("node:child_process");
      const changed = execFileSync("git", ["diff", "--name-only", doSince], { cwd: root }).toString().trim();
      if (changed) {
        sinceFiles = new Set(changed.split("\n").map((f) => f.trim()));
        console.log(`  --since ${doSince}: ${sinceFiles.size} changed files`);
      }
    } catch {
      console.warn(`  Warning: --since failed (not a git repo or invalid ref)`);
    }
  }

  // Install git hook
  if (doHook) {
    await installGitHook(root, outputDirName);
  }

  // --refresh: rebuild monorepo packages and exit
  if (doRefresh) {
    const { runMonorepoScan } = await import("./monorepo/orchestrator.js");
    await runMonorepoScan(root, config, refreshPackage || undefined);
    return;
  }

  // Monorepo mode: route to orchestrator or watch
  if (config.monorepo?.enabled) {
    if (doWatch) {
      const { watchMonorepo } = await import("./monorepo/watch.js");
      await watchMonorepo(root, config);
      return;
    }
    const { runMonorepoScan } = await import("./monorepo/orchestrator.js");
    await runMonorepoScan(root, config);
    return;
  }

  // Knowledge mode: scan .md files instead of code
  if (mode === "knowledge") {
    await runKnowledgeScan(root, outputDirName, maxDepth);
    return;
  }

  // Run scan (passes config for disabled detectors + plugins)
  let result = await scan(root, outputDirName, maxDepth, config);

  // --since: filter result to only show changed files' routes/models
  if (sinceFiles && sinceFiles.size > 0) {
    result = {
      ...result,
      routes: result.routes.filter((r) => sinceFiles!.has(r.file)),
      schemas: result.schemas, // schemas are hard to diff by file, keep all
    };
    console.log(`  --since filter: showing ${result.routes.length} routes from changed files`);
  }

  // --max-tokens: trim output to fit token budget
  if (config.maxTokens && config.maxTokens > 0) {
    result = applyTokenBudget(result, config.maxTokens);
  }

  // Run plugin post-processors
  if (config.plugins) {
    for (const plugin of config.plugins) {
      if (plugin.postProcessor) {
        try {
          result = await plugin.postProcessor(result);
        } catch (err: any) {
          console.warn(`  Warning: plugin "${plugin.name}" post-processor failed: ${err.message}`);
        }
      }
    }
  }

  // Token telemetry
  if (doTelemetry) {
    const { runTelemetry } = await import("./telemetry.js");
    const outputDir = join(root, outputDirName);
    process.stdout.write("  Running telemetry...");
    const report = await runTelemetry(root, result, outputDir);
    console.log(` ${outputDirName}/telemetry.md`);
    console.log(`\n  Telemetry Results:`);
    for (const task of report.tasks) {
      console.log(`    ${task.name}: ${task.reduction}x reduction (${task.tokensWithout.toLocaleString()} → ${task.tokensWith.toLocaleString()} tokens)`);
    }
    console.log(`    Average: ${report.summary.averageReduction}x | Tool calls saved: ${report.summary.totalToolCallsSaved}`);
    console.log("");
  }

  // JSON output
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  }

  // Generate wiki knowledge base
  if (doWiki) {
    const outputDir = join(root, outputDirName);
    process.stdout.write("  Generating wiki...");
    const wikiResult = await generateWiki(result, outputDir);
    const articleList = wikiResult.articles.join(", ");
    console.log(` ${outputDirName}/wiki/ (${wikiResult.articles.length} articles, ~${wikiResult.tokenEstimate.toLocaleString()} tokens total)`);
    console.log(`  Articles: ${articleList}`);
    console.log(`  Index:    ${outputDirName}/wiki/index.md`);
    console.log(`  Log:      ${outputDirName}/wiki/log.md`);
    console.log("");
    console.log(`  Session tip: read ${outputDirName}/wiki/index.md at session start (~200 tokens)`);
    console.log(`  vs full scan: ~${result.tokenStats.outputTokens.toLocaleString()} tokens — load targeted articles instead`);
    console.log("");
  }

  // Generate AI config files
  if (doInit) {
    process.stdout.write("  Generating AI configs...");
    const generated = await generateAIConfigs(result, root);
    if (generated.length > 0) {
      console.log(` ${generated.join(", ")}`);
    } else {
      console.log(" all configs already exist");
    }
  }

  // Generate HTML report
  if (doHtml) {
    const outputDir = join(root, outputDirName);
    process.stdout.write("  Generating HTML report...");
    const reportPath = await generateHtmlReport(result, outputDir);
    console.log(` ${outputDirName}/report.html`);

    if (doOpen) {
      const { execFile } = await import("node:child_process");
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      execFile(cmd, [reportPath]);
      console.log("  Opening in browser...");
    }
  }

  // Benchmark output
  if (doBenchmark) {
    const ts = result.tokenStats;
    const r = result;
    console.log(`
  Token Savings Breakdown:
  ┌──────────────────────────────────────────────────┐
  │ What codesight found         │ Exploration cost   │
  ├──────────────────────────────┼────────────────────┤
  │ ${String(r.routes.length).padStart(3)} routes                   │ ~${(r.routes.length * 400).toLocaleString().padStart(6)} tokens     │
  │ ${String(r.schemas.length).padStart(3)} schema models            │ ~${(r.schemas.length * 300).toLocaleString().padStart(6)} tokens     │
  │ ${String(r.components.length).padStart(3)} components              │ ~${(r.components.length * 250).toLocaleString().padStart(6)} tokens     │
  │ ${String(r.libs.length).padStart(3)} library files            │ ~${(r.libs.length * 200).toLocaleString().padStart(6)} tokens     │
  │ ${String(r.config.envVars.length).padStart(3)} env vars                │ ~${(r.config.envVars.length * 100).toLocaleString().padStart(6)} tokens     │
  │ ${String(r.middleware.length).padStart(3)} middleware              │ ~${(r.middleware.length * 200).toLocaleString().padStart(6)} tokens     │
  │ ${String(r.graph.hotFiles.length).padStart(3)} hot files               │ ~${(r.graph.hotFiles.length * 150).toLocaleString().padStart(6)} tokens     │
  │ ${String(ts.fileCount).padStart(3)} files (search overhead) │ ~${(Math.min(ts.fileCount, 50) * 80).toLocaleString().padStart(6)} tokens     │
  ├──────────────────────────────┼────────────────────┤
  │ codesight output             │ ~${ts.outputTokens.toLocaleString().padStart(6)} tokens     │
  │ Manual exploration (1.3x)    │ ~${ts.estimatedExplorationTokens.toLocaleString().padStart(6)} tokens     │
  │ SAVED PER CONVERSATION       │ ~${ts.saved.toLocaleString().padStart(6)} tokens     │
  └──────────────────────────────┴────────────────────┘

  How this is calculated:
  - Each route found saves ~400 tokens of file reading + grep exploration
  - Each schema model saves ~300 tokens of migration/ORM file parsing
  - Each component saves ~250 tokens of prop discovery
  - Search overhead: AI typically runs ${Math.min(ts.fileCount, 50)} glob/grep operations
  - 1.3x multiplier: AI revisits files during multi-turn exploration
`);
  }

  // Blast radius analysis
  if (doBlast) {
    const { analyzeBlastRadius } = await import("./detectors/blast-radius.js");
    const br = analyzeBlastRadius(doBlast, result);

    console.log(`\n  Blast Radius: ${doBlast}`);
    console.log(`  Depth: ${br.depth} hops\n`);

    if (br.affectedFiles.length > 0) {
      console.log(`  Affected files (${br.affectedFiles.length}):`);
      for (const f of br.affectedFiles.slice(0, 20)) {
        console.log(`    ${f}`);
      }
      if (br.affectedFiles.length > 20) console.log(`    ... +${br.affectedFiles.length - 20} more`);
    }

    if (br.affectedRoutes.length > 0) {
      console.log(`\n  Affected routes (${br.affectedRoutes.length}):`);
      for (const r of br.affectedRoutes) {
        console.log(`    ${r.method} ${r.path} — ${r.file}`);
      }
    }

    if (br.affectedModels.length > 0) {
      console.log(`\n  Affected models: ${br.affectedModels.join(", ")}`);
    }

    if (br.affectedMiddleware.length > 0) {
      console.log(`\n  Affected middleware: ${br.affectedMiddleware.join(", ")}`);
    }

    if (br.affectedFiles.length === 0) {
      console.log("  No downstream dependencies. Minimal blast radius.");
    }
    console.log("");
  }

  // Profile-based AI config generation
  if (doProfile) {
    const { generateProfileConfig } = await import("./generators/ai-config.js");
    process.stdout.write(`  Generating ${doProfile} profile...`);
    const file = await generateProfileConfig(result, root, doProfile);
    console.log(` ${file}`);
  }

  // Watch mode (blocks)
  if (doWatch) {
    await watchMode(root, outputDirName, maxDepth, config, doWiki);
  }
}

/**
 * Trim ScanResult to fit within a token budget.
 * Priority order (highest to lowest):
 *   1. Routes tagged with [auth, payment, ai] — keep
 *   2. Schema models with most fields — keep
 *   3. Remaining routes by tag count (more tags = more important)
 *   4. Components, libs — trim from the tail
 */
function applyTokenBudget(result: ScanResult, maxTokens: number): ScanResult {
  // Rough estimate: each route line ~15 tokens, model ~8+fields*5, component ~10
  const routeWeight = (r: ScanResult["routes"][0]) => {
    const priority = ["auth", "payment", "ai", "queue"].filter((t) => r.tags.includes(t)).length;
    return priority * 100 + r.tags.length * 10;
  };

  let estimatedTokens =
    result.routes.length * 15 +
    result.schemas.reduce((s, m) => s + 8 + m.fields.length * 5, 0) +
    result.components.length * 10 +
    result.libs.length * 8;

  if (estimatedTokens <= maxTokens) return result; // already fits

  // Sort routes by importance, trim from the tail
  const sortedRoutes = [...result.routes].sort((a, b) => routeWeight(b) - routeWeight(a));
  let trimmedRoutes = sortedRoutes;
  let trimmedComponents = result.components;
  let trimmedLibs = result.libs;

  while (estimatedTokens > maxTokens && trimmedLibs.length > 0) {
    trimmedLibs = trimmedLibs.slice(0, Math.floor(trimmedLibs.length * 0.7));
    estimatedTokens = trimmedRoutes.length * 15 +
      result.schemas.reduce((s, m) => s + 8 + m.fields.length * 5, 0) +
      trimmedComponents.length * 10 + trimmedLibs.length * 8;
  }

  while (estimatedTokens > maxTokens && trimmedComponents.length > 0) {
    trimmedComponents = trimmedComponents.slice(0, Math.floor(trimmedComponents.length * 0.7));
    estimatedTokens = trimmedRoutes.length * 15 +
      result.schemas.reduce((s, m) => s + 8 + m.fields.length * 5, 0) +
      trimmedComponents.length * 10 + trimmedLibs.length * 8;
  }

  while (estimatedTokens > maxTokens && trimmedRoutes.length > 10) {
    trimmedRoutes = trimmedRoutes.slice(0, Math.floor(trimmedRoutes.length * 0.8));
    estimatedTokens = trimmedRoutes.length * 15 +
      result.schemas.reduce((s, m) => s + 8 + m.fields.length * 5, 0) +
      trimmedComponents.length * 10 + trimmedLibs.length * 8;
  }

  console.log(`  Token budget: trimmed to ~${estimatedTokens} tokens (limit: ${maxTokens})`);

  return { ...result, routes: trimmedRoutes, components: trimmedComponents, libs: trimmedLibs };
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

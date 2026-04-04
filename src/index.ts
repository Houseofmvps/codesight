#!/usr/bin/env node

import { resolve, join } from "node:path";
import { writeFile, stat, mkdir } from "node:fs/promises";
import { collectFiles, detectProject } from "./scanner.js";
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
import { generateAIConfigs } from "./generators/ai-config.js";
import { generateHtmlReport } from "./generators/html-report.js";
import type { ScanResult } from "./types.js";

const VERSION = "1.0.1";
const BRAND = "codesight";

function printHelp() {
  console.log(`
  ${BRAND} v${VERSION} — See your codebase clearly

  Usage: ${BRAND} [options] [directory]

  Options:
    -o, --output <dir>   Output directory (default: .codesight)
    -d, --depth <n>      Max directory depth (default: 10)
    --init               Generate AI config files (CLAUDE.md, .cursorrules, etc.)
    --watch              Re-scan on file changes
    --hook               Install git pre-commit hook
    --html               Generate interactive HTML report
    --open               Generate HTML report and open in browser
    --mcp                Start as MCP server (for Claude Code, Cursor)
    --json               Output JSON instead of markdown
    -v, --version        Show version
    -h, --help           Show this help

  Examples:
    npx ${BRAND}                    # Scan current directory
    npx ${BRAND} --init             # Scan + generate AI config files
    npx ${BRAND} --open             # Scan + open visual report
    npx ${BRAND} --watch            # Watch mode, re-scan on changes
    npx ${BRAND} --mcp              # Start MCP server
    npx ${BRAND} --hook             # Install git pre-commit hook
    npx ${BRAND} ./my-project       # Scan specific directory
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

async function scan(root: string, outputDirName: string, maxDepth: number): Promise<ScanResult> {
  const outputDir = join(root, outputDirName);

  console.log(`\n  ${BRAND} v${VERSION}`);
  console.log(`  Scanning: ${root}\n`);

  const startTime = Date.now();

  // Step 1: Detect project
  process.stdout.write("  Detecting project...");
  const project = await detectProject(root);
  console.log(
    ` ${project.frameworks.length > 0 ? project.frameworks.join(", ") : "generic"} | ${project.orms.length > 0 ? project.orms.join(", ") : "no ORM"} | ${project.language}`
  );

  if (project.isMonorepo) {
    console.log(`  Monorepo: ${project.workspaces.map((w) => w.name).join(", ")}`);
  }

  // Step 2: Collect files
  process.stdout.write("  Collecting files...");
  const files = await collectFiles(root, maxDepth);
  console.log(` ${files.length} files`);

  // Step 3: Run all detectors in parallel
  process.stdout.write("  Analyzing...");

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

  // Step 4: Enrich routes with contract info
  const routes = await enrichRouteContracts(rawRoutes, project);

  console.log(" done");

  // Step 5: Write output
  process.stdout.write("  Writing output...");

  // Temporary result without token stats to generate output
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

  const outputContent = await writeOutput(tempResult, outputDir);

  // Step 6: Calculate real token stats
  const tokenStats = calculateTokenStats(tempResult, outputContent, files.length);
  const result: ScanResult = { ...tempResult, tokenStats };

  // Re-write with accurate token stats
  await writeOutput(result, outputDir);

  console.log(` ${outputDirName}/`);

  const elapsed = Date.now() - startTime;

  // Stats
  console.log(`
  Results:
    Routes:       ${routes.length}
    Models:       ${schemas.length}
    Components:   ${components.length}
    Libraries:    ${libs.length}
    Env vars:     ${config.envVars.length}
    Middleware:    ${middleware.length}
    Import links: ${graph.edges.length}
    Hot files:    ${graph.hotFiles.length}

  Tokens:
    Output size:     ~${tokenStats.outputTokens.toLocaleString()} tokens
    Exploration cost: ~${tokenStats.estimatedExplorationTokens.toLocaleString()} tokens
    Saved:           ~${tokenStats.saved.toLocaleString()} tokens per conversation

  Done in ${elapsed}ms
`);

  return result;
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

  const hookCommand = `\n# codesight: regenerate AI context\nnpx codesight -o ${outputDirName}\ngit add ${outputDirName}/\n`;

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

async function watchMode(root: string, outputDirName: string, maxDepth: number) {
  console.log(`  Watching for changes... (Ctrl+C to stop)\n`);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let isScanning = false;

  const runScan = async () => {
    if (isScanning) return;
    isScanning = true;
    try {
      console.log("\n  Changes detected, re-scanning...\n");
      await scan(root, outputDirName, maxDepth);
    } catch (err: any) {
      console.error("  Scan error:", err.message);
    }
    isScanning = false;
  };

  // Use polling approach for cross-platform compatibility
  const { watch } = await import("node:fs");
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    // Skip output directory and hidden files
    if (filename.startsWith(outputDirName) || filename.startsWith(".git")) return;
    if (filename.includes("node_modules")) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runScan, 500);
  });

  // Keep process alive
  process.on("SIGINT", () => {
    watcher.close();
    console.log("\n  Watch mode stopped.");
    process.exit(0);
  });

  // Wait forever
  await new Promise(() => {});
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
  let doInit = false;
  let doWatch = false;
  let doHook = false;
  let doHtml = false;
  let doOpen = false;
  let doMcp = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-o" || arg === "--output") && args[i + 1]) {
      outputDirName = args[++i];
    } else if ((arg === "-d" || arg === "--depth") && args[i + 1]) {
      maxDepth = parseInt(args[++i], 10);
    } else if (arg === "--json") {
      jsonOutput = true;
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

  const root = resolve(targetDir);

  // Install git hook
  if (doHook) {
    await installGitHook(root, outputDirName);
  }

  // Run scan
  const result = await scan(root, outputDirName, maxDepth);

  // JSON output
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
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
      const { exec } = await import("node:child_process");
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      exec(`${cmd} "${reportPath}"`);
      console.log("  Opening in browser...");
    }
  }

  // Watch mode (blocks)
  if (doWatch) {
    await watchMode(root, outputDirName, maxDepth);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

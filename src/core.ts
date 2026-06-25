import { join } from "node:path";
import { collectFiles, detectProject, readCodesightIgnore } from "./scanner.js";
import { detectRoutes } from "./detectors/routes.js";
import { detectSchemas } from "./detectors/schema.js";
import { detectComponents } from "./detectors/components.js";
import { detectLibs } from "./detectors/libs.js";
import { detectConfig } from "./detectors/config.js";
import { detectMiddleware } from "./detectors/middleware.js";
import { detectDependencyGraph } from "./detectors/graph.js";
import { enrichRouteContracts } from "./detectors/contracts.js";
import { calculateTokenStats } from "./detectors/tokens.js";
import { detectGraphQLRoutes, detectGRPCRoutes, detectWebSocketRoutes } from "./detectors/graphql.js";
import { detectEvents } from "./detectors/events.js";
import { detectTestCoverage } from "./detectors/coverage.js";
import { detectOpenAPISpec } from "./detectors/openapi.js";
import { writeOutput, computeCrudGroups } from "./formatter.js";
import { resolveNativeAst } from "./ast/native-loader.js";
import { createBuiltinPlugins } from "./plugins/index.js";
import { detectNative, mergeNativeRoutes, mergeNativeSchemas } from "./detectors/native.js";
import { createRequire } from "node:module";
import type { ScanResult, CodesightConfig } from "./types.js";

const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };
export const VERSION: string = _pkg.version;
export const BRAND = "codesight";

export async function scan(
  root: string,
  outputDirName: string,
  maxDepth: number,
  userConfig: CodesightConfig = {},
  quiet = false
): Promise<ScanResult> {
  const outputDir = join(root, outputDirName);

  if (!quiet) {
    console.log(`\n  ${BRAND} v${VERSION}`);
    console.log(`  Scanning: ${root}\n`);
  }

  const startTime = Date.now();

  // Step 1: Detect project
  if (!quiet) process.stdout.write("  Detecting project...");
  const project = await detectProject(root);
  if (!quiet) {
    console.log(
      ` ${project.frameworks.length > 0 ? project.frameworks.join(", ") : "generic"} | ${project.orms.length > 0 ? project.orms.join(", ") : "no ORM"} | ${project.language}`
    );
    if (project.isMonorepo) {
      const repoLabel = project.repoType === "meta" ? "Meta-repo"
        : project.repoType === "microservices" ? "Microservices"
        : "Monorepo";
      console.log(`  ${repoLabel}: ${project.workspaces.map((w) => w.name).join(", ")}`);
    }
  }

  // Step 2: Collect files — merge .codesightignore + config ignorePatterns
  if (!quiet) process.stdout.write("  Collecting files...");
  const ignoreFromFile = await readCodesightIgnore(root);
  const allIgnorePatterns = [...(userConfig.ignorePatterns ?? []), ...ignoreFromFile];
  const files = await collectFiles(root, maxDepth, allIgnorePatterns);
  if (!quiet) console.log(` ${files.length} files`);

  // Step 3: Run all detectors in parallel (respecting disableDetectors config)
  if (!quiet) process.stdout.write("  Analyzing...");

  const disabled = new Set(userConfig.disableDetectors || []);

  // Resolve native-AST settings once. Detectors that consult plugins call
  // resolveNativeAst with the same userConfig and share this instance (and its
  // diagnostics sink) via reference memoization.
  const nativeResolved = resolveNativeAst(userConfig.nativeAst, project.root);

  const [rawHttpRoutes, builtinSchemas, components, libs, configResult, middleware, graph,
         graphqlRoutes, grpcRoutes, wsRoutes, events, openapi] =
    await Promise.all([
      disabled.has("routes") ? Promise.resolve([]) : detectRoutes(files, project, userConfig),
      disabled.has("schema") ? Promise.resolve([]) : detectSchemas(files, project, userConfig),
      disabled.has("components") ? Promise.resolve([]) : detectComponents(files, project, userConfig),
      disabled.has("libs") ? Promise.resolve([]) : detectLibs(files, project),
      disabled.has("config") ? Promise.resolve({ envVars: [], configFiles: [], dependencies: {}, devDependencies: {} }) : detectConfig(files, project),
      disabled.has("middleware") ? Promise.resolve([]) : detectMiddleware(files, project),
      disabled.has("graph") ? Promise.resolve({ edges: [], hotFiles: [] }) : detectDependencyGraph(files, project, userConfig),
      disabled.has("graphql") ? Promise.resolve([]) : detectGraphQLRoutes(files, project),
      disabled.has("graphql") ? Promise.resolve([]) : detectGRPCRoutes(files, project),
      disabled.has("graphql") ? Promise.resolve([]) : detectWebSocketRoutes(files, project),
      disabled.has("events") ? Promise.resolve([]) : detectEvents(files, project),
      detectOpenAPISpec(root, project),
    ]);

  // Generic language-driven native pass — the single place WASM plugins are
  // dispatched. Merge into the built-in results (native-preferred; authoritative
  // languages replace built-ins per file — routes only, see native.ts).
  const native = await detectNative(files, project, nativeResolved);
  const httpRoutes = disabled.has("routes")
    ? rawHttpRoutes
    : mergeNativeRoutes(rawHttpRoutes, native.routes, nativeResolved, native.registry);
  const schemas = disabled.has("schema")
    ? builtinSchemas
    : mergeNativeSchemas(builtinSchemas, native.schemas);

  // Merge OpenAPI routes and schemas if spec found
  const rawRoutes = [...httpRoutes, ...graphqlRoutes, ...grpcRoutes, ...wsRoutes];
  if (openapi.routes.length > 0) {
    if (rawRoutes.length === 0) rawRoutes.push(...openapi.routes);
    const existingModelNames = new Set(schemas.map((m) => m.name.toLowerCase()));
    for (const m of openapi.schemas) {
      if (!existingModelNames.has(m.name.toLowerCase())) schemas.push(m);
    }
  }

  // Step 3b: Run plugin detectors. Built-in plugins (cicd/githooks/skills) run
  // by default — each self-gates to nothing when its target files are absent —
  // followed by any user-supplied plugins. Opt out of a built-in via
  // disableDetectors: ["cicd"]. terraform is opt-in only (see plugins/index.ts).
  const customSections: { name: string; content: string }[] = [];
  const activePlugins = [...createBuiltinPlugins(disabled), ...(userConfig.plugins ?? [])];
  if (activePlugins.length > 0) {
    for (const plugin of activePlugins) {
      if (plugin.detector) {
        try {
          const pluginResult = await plugin.detector(files, project);
          if (pluginResult.routes) rawRoutes.push(...pluginResult.routes);
          if (pluginResult.schemas) schemas.push(...pluginResult.schemas);
          if (pluginResult.components) components.push(...pluginResult.components);
          if (pluginResult.middleware) middleware.push(...pluginResult.middleware);
          if (pluginResult.customSections) customSections.push(...pluginResult.customSections);
        } catch (err: any) {
          if (!quiet) console.warn(`\n  Warning: plugin "${plugin.name}" failed: ${err.message}`);
        }
      }
    }
  }

  // Step 4: Enrich routes with contract info
  const routes = await enrichRouteContracts(rawRoutes, project);

  // Step 4b: Test coverage detection
  const testCoverage = await detectTestCoverage(files, routes, schemas, root);

  // Step 4c: Compute CRUD groups
  const crudGroups = computeCrudGroups(routes);

  // Report AST vs regex detection
  if (!quiet) {
    const astRoutes = routes.filter((r) => r.confidence === "ast").length;
    const astSchemas = schemas.filter((s) => s.confidence === "ast").length;
    const astComponents = components.filter((c) => c.confidence === "ast").length;
    const totalAST = astRoutes + astSchemas + astComponents;
    const nativeRoutes = routes.filter((r) => r.confidence === "native").length;
    const nativeSchemas = schemas.filter((s) => s.confidence === "native").length;
    const nativeComponents = components.filter((c) => c.confidence === "native").length;
    const totalNative = nativeRoutes + nativeSchemas + nativeComponents;
    const specialCounts: string[] = [];
    const gqlCount = routes.filter((r) => ["QUERY", "MUTATION", "SUBSCRIPTION"].includes(r.method)).length;
    const grpcCount = routes.filter((r) => r.method === "RPC").length;
    const wsCount = routes.filter((r) => r.method === "WS" || r.method === "WS-ROOM").length;
    if (gqlCount > 0) specialCounts.push(`${gqlCount} graphql`);
    if (grpcCount > 0) specialCounts.push(`${grpcCount} rpc`);
    if (wsCount > 0) specialCounts.push(`${wsCount} ws`);
    if (events.length > 0) specialCounts.push(`${events.length} events`);
    const specialStr = specialCounts.length > 0 ? `, ${specialCounts.join(", ")}` : "";
    const detail: string[] = [];
    if (totalNative > 0) detail.push(`native: ${nativeRoutes} routes, ${nativeSchemas} models, ${nativeComponents} components`);
    if (totalAST > 0) detail.push(`AST: ${astRoutes} routes, ${astSchemas} models, ${astComponents} components`);
    if (detail.length > 0) {
      console.log(` done (${detail.join(" | ")}${specialStr})`);
    } else if (specialCounts.length > 0) {
      console.log(` done (${specialCounts.join(", ")})`);
    } else {
      console.log(" done");
    }
    for (const w of nativeResolved.warnings) console.warn(`  Native-AST: ${w}`);
  }

  // Step 5: Write output
  if (!quiet) process.stdout.write("  Writing output...");

  // Temporary result without token stats to generate output
  const tempResult: ScanResult = {
    project,
    routes,
    schemas,
    components,
    libs,
    config: configResult,
    middleware,
    graph,
    tokenStats: { outputTokens: 0, estimatedExplorationTokens: 0, saved: 0, fileCount: files.length },
    events: events.length > 0 ? events : undefined,
    testCoverage: testCoverage.testFiles.length > 0 ? testCoverage : undefined,
    crudGroups: crudGroups.length > 0 ? crudGroups : undefined,
    customSections: customSections.length > 0 ? customSections : undefined,
    nativeDiagnostics: nativeResolved.diagnostics.length > 0 ? nativeResolved.diagnostics : undefined,
  };

  const outputContent = await writeOutput(tempResult, outputDir);

  // Step 6: Calculate real token stats
  const tokenStats = calculateTokenStats(tempResult, outputContent, files.length);
  const result: ScanResult = { ...tempResult, tokenStats };

  // Re-write with accurate token stats
  await writeOutput(result, outputDir);

  const elapsed = Date.now() - startTime;

  if (!quiet) {
    console.log(` ${outputDirName}/`);
    console.log(`
  Results:
    Routes:       ${routes.length}
    Models:       ${schemas.length}
    Components:   ${components.length}
    Libraries:    ${libs.length}
    Env vars:     ${configResult.envVars.length}
    Middleware:    ${middleware.length}
    Import links: ${graph.edges.length}
    Hot files:    ${graph.hotFiles.length}

  Tokens:
    Output size:     ~${tokenStats.outputTokens.toLocaleString()} tokens
    Exploration cost: ~${tokenStats.estimatedExplorationTokens.toLocaleString()} tokens
    Saved:           ~${tokenStats.saved.toLocaleString()} tokens per conversation

  Done in ${elapsed}ms
`);
  }

  return result;
}

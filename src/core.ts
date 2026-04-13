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
import type { ScanResult, CodesightConfig } from "./types.js";

export const VERSION = "1.12.0";
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

  if (!quiet) process.stdout.write("  Detecting project...");
  const project = await detectProject(root);
  if (!quiet) {
    console.log(
      ` ${project.frameworks.length > 0 ? project.frameworks.join(", ") : "generic"} | ${project.orms.length > 0 ? project.orms.join(", ") : "no ORM"} | ${project.language}`
    );
    if (project.isMonorepo) {
      console.log(`  Monorepo: ${project.workspaces.map((w) => w.name).join(", ")}`);
    }
  }

  if (!quiet) process.stdout.write("  Collecting files...");
  const ignoreFromFile = await readCodesightIgnore(root);
  const allIgnorePatterns = [...(userConfig.ignorePatterns ?? []), ...ignoreFromFile];
  const files = await collectFiles(root, maxDepth, allIgnorePatterns);
  if (!quiet) console.log(` ${files.length} files`);

  if (!quiet) process.stdout.write("  Analyzing...");

  const disabled = new Set(userConfig.disableDetectors || []);

  const [rawHttpRoutes, schemas, components, libs, configResult, middleware, graph,
         graphqlRoutes, grpcRoutes, wsRoutes, events, openapi] =
    await Promise.all([
      disabled.has("routes") ? Promise.resolve([]) : detectRoutes(files, project, userConfig),
      disabled.has("schema") ? Promise.resolve([]) : detectSchemas(files, project),
      disabled.has("components") ? Promise.resolve([]) : detectComponents(files, project),
      disabled.has("libs") ? Promise.resolve([]) : detectLibs(files, project),
      disabled.has("config") ? Promise.resolve({ envVars: [], configFiles: [], dependencies: {}, devDependencies: {} }) : detectConfig(files, project),
      disabled.has("middleware") ? Promise.resolve([]) : detectMiddleware(files, project),
      disabled.has("graph") ? Promise.resolve({ edges: [], hotFiles: [] }) : detectDependencyGraph(files, project),
      disabled.has("graphql") ? Promise.resolve([]) : detectGraphQLRoutes(files, project),
      disabled.has("graphql") ? Promise.resolve([]) : detectGRPCRoutes(files, project),
      disabled.has("graphql") ? Promise.resolve([]) : detectWebSocketRoutes(files, project),
      disabled.has("events") ? Promise.resolve([]) : detectEvents(files, project),
      detectOpenAPISpec(root, project),
    ]);

  const rawRoutes = [...rawHttpRoutes, ...graphqlRoutes, ...grpcRoutes, ...wsRoutes];
  if (openapi.routes.length > 0) {
    if (rawRoutes.length === 0) rawRoutes.push(...openapi.routes);
    const existingModelNames = new Set(schemas.map((m) => m.name.toLowerCase()));
    for (const m of openapi.schemas) {
      if (!existingModelNames.has(m.name.toLowerCase())) schemas.push(m);
    }
  }

  if (userConfig.plugins) {
    for (const plugin of userConfig.plugins) {
      if (plugin.detector) {
        try {
          const pluginResult = await plugin.detector(files, project);
          if (pluginResult.routes) rawRoutes.push(...pluginResult.routes);
          if (pluginResult.schemas) schemas.push(...pluginResult.schemas);
          if (pluginResult.components) components.push(...pluginResult.components);
          if (pluginResult.middleware) middleware.push(...pluginResult.middleware);
        } catch (err: any) {
          if (!quiet) console.warn(`\n  Warning: plugin "${plugin.name}" failed: ${err.message}`);
        }
      }
    }
  }

  const routes = await enrichRouteContracts(rawRoutes, project);
  const testCoverage = await detectTestCoverage(files, routes, schemas, root);
  const crudGroups = computeCrudGroups(routes);

  if (!quiet) {
    const astRoutes = routes.filter((r) => r.confidence === "ast").length;
    const astSchemas = schemas.filter((s) => s.confidence === "ast").length;
    const astComponents = components.filter((c) => c.confidence === "ast").length;
    const totalAST = astRoutes + astSchemas + astComponents;
    const specialCounts: string[] = [];
    const gqlCount = routes.filter((r) => ["QUERY", "MUTATION", "SUBSCRIPTION"].includes(r.method)).length;
    const grpcCount = routes.filter((r) => r.method === "RPC").length;
    const wsCount = routes.filter((r) => r.method === "WS" || r.method === "WS-ROOM").length;
    if (gqlCount > 0) specialCounts.push(`${gqlCount} graphql`);
    if (grpcCount > 0) specialCounts.push(`${grpcCount} rpc`);
    if (wsCount > 0) specialCounts.push(`${wsCount} ws`);
    if (events.length > 0) specialCounts.push(`${events.length} events`);
    const specialStr = specialCounts.length > 0 ? `, ${specialCounts.join(", ")}` : "";
    if (totalAST > 0) {
      console.log(` done (AST: ${astRoutes} routes, ${astSchemas} models, ${astComponents} components${specialStr})`);
    } else if (specialCounts.length > 0) {
      console.log(` done (${specialCounts.join(", ")})`);
    } else {
      console.log(" done");
    }
  }

  if (!quiet) process.stdout.write("  Writing output...");

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
  };

  const outputContent = await writeOutput(tempResult, outputDir);
  const tokenStats = calculateTokenStats(tempResult, outputContent, files.length);
  const result: ScanResult = { ...tempResult, tokenStats };
  await writeOutput(result, outputDir);

  if (!quiet) {
    const elapsed = Date.now() - startTime;
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

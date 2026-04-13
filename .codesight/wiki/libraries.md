# Libraries

> **Navigation aid.** Library inventory extracted via AST. Read the source files listed here before modifying exported functions.

**40 library files** across 11 modules

## Detectors (15 files)

- `src/detectors/libs.ts` — detectLibs, name, name, Name, Name, Name, …
- `src/detectors/graphql.ts` — detectGraphQLRoutes, detectGRPCRoutes, detectWebSocketRoutes
- `src/detectors/blast-radius.ts` — analyzeBlastRadius, analyzeMultiFileBlastRadius
- `src/detectors/components.ts` — detectComponents, ComponentName
- `src/detectors/coverage.ts` — isTestFile, detectTestCoverage
- `src/detectors/openapi.ts` — detectOpenAPISpec, OpenAPIResult
- `src/detectors/routes.ts` — detectRoutes, GET
- `src/detectors/schema.ts` — detectSchemas, users
- `src/detectors/tokens.ts` — estimateTokens, calculateTokenStats
- `src/detectors/config.ts` — detectConfig
- `src/detectors/contracts.ts` — enrichRouteContracts
- `src/detectors/events.ts` — detectEvents
- `src/detectors/graph.ts` — detectDependencyGraph
- `src/detectors/knowledge.ts` — detectKnowledge
- `src/detectors/middleware.ts` — detectMiddleware

## Ast (11 files)

- `src/ast/loader.ts` — loadTypeScript, resetCache, parseSourceFile, getDecorators, parseDecorator, getText
- `src/ast/extract-android.ts` — extractRetrofitRoutes, extractRoomEntities, extractComposeComponents, extractNavigationRoutes, extractActivitiesFromManifest
- `src/ast/extract-python.ts` — extractPythonRoutesAST, extractSQLAlchemyAST, extractDjangoModelsAST, extractSQLModelAST, isPythonAvailable
- `src/ast/extract-csharp.ts` — extractAspNetControllerRoutes, extractAspNetMinimalApiRoutes, extractEntityFrameworkModels, extractCSharpExports
- `src/ast/extract-components.ts` — extractReactComponentsAST, ComponentName, ComponentName
- `src/ast/extract-dart.ts` — extractFlutterRoutes, extractFlutterWidgets, extractDartExports
- `src/ast/extract-go.ts` — extractGoRoutesStructured, extractGORMModelsStructured, extractEntSchemasStructured
- `src/ast/extract-php.ts` — extractLaravelRoutes, extractEloquentModels, extractPhpExports
- `src/ast/extract-swift.ts` — extractVaporRoutes, extractSwiftUIViews, extractSwiftExports
- `src/ast/extract-schema.ts` — extractDrizzleSchemaAST, extractTypeORMSchemaAST
- `src/ast/extract-routes.ts` — extractRoutesAST

## Monorepo (4 files)

- `src/monorepo/deps.ts` — extractCrossPackageDeps, writeDepsFile
- `src/monorepo/discover.ts` — discoverPackages, PackageInfo
- `src/monorepo/orchestrator.ts` — runMonorepoScan
- `src/monorepo/watch.ts` — watchMonorepo

## Generators (3 files)

- `src/generators/wiki.ts` — generateWiki, readWikiArticle, listWikiArticles, lintWiki, WikiResult
- `src/generators/ai-config.ts` — generateAIConfigs, generateProfileConfig, generateMonorepoAIConfigs
- `src/generators/html-report.ts` — generateHtmlReport

## Config.ts (1 files)

- `src/config.ts` — loadConfig, mergeCliConfig

## Core.ts (1 files)

- `src/core.ts` — scan, VERSION, BRAND

## Eval.ts (1 files)

- `src/eval.ts` — runEval

## Formatter.ts (1 files)

- `src/formatter.ts` — writeOutput, computeCrudGroups, formatKnowledge, writeKnowledgeOutput

## Mcp-server.ts (1 files)

- `src/mcp-server.ts` — startMCPServer

## Scanner.ts (1 files)

- `src/scanner.ts` — readCodesightIgnore, loadFileHashCache, saveFileHashCache, hashFileContent, collectFiles, readFileSafe, …

## Telemetry.ts (1 files)

- `src/telemetry.ts` — runTelemetry, TelemetryTask, TelemetryReport

---
_Back to [overview.md](./overview.md)_
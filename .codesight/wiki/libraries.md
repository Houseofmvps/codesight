# Libraries

> **Navigation aid.** Library inventory extracted via AST. Read the source files listed here before modifying exported functions.

**61 library files** across 12 modules

## Plugins (18 files)

- `src/plugins/terraform/hcl-parser.ts` — parseHclFile, parseTfvars, stripComments, extractBraceBlock
- `src/plugins/terraform/file-collector.ts` — collectTfFiles, readFileSafe, CollectedFiles
- `src/plugins/terraform/service-matcher.ts` — matchServiceBlocks, normaliseServiceName, ScoredBlock
- `src/plugins/cicd/index.ts` — createCICDPlugin, CICDPluginConfig
- `src/plugins/cicd/yaml-parser.ts` — parseYAML, parseFlowSequence
- `src/plugins/skills/index.ts` — createSkillsPlugin, Skill
- `src/plugins/terraform/extractor.ts` — extractServiceInfrastructure, extractEnvironments
- `src/plugins/cicd/circleci.ts` — extractCircleCIWorkflows
- `src/plugins/cicd/formatter.ts` — formatCICD
- `src/plugins/cicd/github-actions.ts` — extractGitHubActionsWorkflow
- `src/plugins/githooks/formatter.ts` — formatGitHooks
- `src/plugins/githooks/husky.ts` — parseHusky
- `src/plugins/githooks/index.ts` — createGitHooksPlugin
- `src/plugins/githooks/lefthook.ts` — parseLefthook
- `src/plugins/githooks/raw.ts` — parseRawHooks
- `src/plugins/skills/formatter.ts` — formatSkills
- `src/plugins/terraform/formatter.ts` — formatInfrastructure
- `src/plugins/terraform/index.ts` — createTerraformPlugin

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

## Ast (14 files)

- `src/ast/extract-brightscript.ts` — extractBrightScriptFunctions, extractBrightScriptObservers, extractBrightScriptNavigationCalls, extractBrightScriptShowScreenCalls, extractBrightScriptGraphqlCalls, extractBrightScriptGlobalFields, …
- `src/ast/loader.ts` — loadTypeScript, resetCache, parseSourceFile, getDecorators, parseDecorator, getText
- `src/ast/extract-android.ts` — extractRetrofitRoutes, extractRoomEntities, extractComposeComponents, extractNavigationRoutes, extractActivitiesFromManifest
- `src/ast/extract-python.ts` — extractPythonRoutesAST, extractSQLAlchemyAST, extractDjangoModelsAST, extractSQLModelAST, isPythonAvailable
- `src/ast/extract-csharp.ts` — extractAspNetControllerRoutes, extractAspNetMinimalApiRoutes, extractEntityFrameworkModels, extractCSharpExports
- `src/ast/extract-scenegraph.ts` — extractSceneGraphComponent, extractMainSceneScreens, isSceneGraphXml, SceneGraphComponent
- `src/ast/extract-components.ts` — extractReactComponentsAST, ComponentName, ComponentName
- `src/ast/extract-dart.ts` — extractFlutterRoutes, extractFlutterWidgets, extractDartExports
- `src/ast/extract-go.ts` — extractGoRoutesStructured, extractGORMModelsStructured, extractEntSchemasStructured
- `src/ast/extract-php.ts` — extractLaravelRoutes, extractEloquentModels, extractPhpExports
- `src/ast/extract-swift.ts` — extractVaporRoutes, extractSwiftUIViews, extractSwiftExports
- `src/ast/extract-brighterscript.ts` — extractBrighterScriptImports, extractBrighterScriptExports
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
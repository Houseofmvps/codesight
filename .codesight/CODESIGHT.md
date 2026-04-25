# codesight — AI Context Map

> **Stack:** raw-http | none | unknown | typescript

> 4 routes (8 inferred) + 1 graphql + 3 ws | 0 models | 0 components | 61 lib files | 5 env vars | 1 middleware | 6 events | 60% test coverage
> **Token savings:** this file is ~4,400 tokens. Without it, AI exploration would cost ~30,200 tokens. **Saves ~25,700 tokens per conversation.**
> **Last scanned:** 2026-04-25 11:57 — re-run after significant changes

---

# Routes

- `ALL` `/path` [auth, db, cache, queue, email, payment, upload, ai] `[inferred]`
- `ALL` `/api` [auth, db, cache, queue, email, payment, upload, ai] `[inferred]`
- `ALL` `/health` [auth, db, cache, queue, payment] `[inferred]` ✓
- `GET` `/api/users` [auth, db, cache, queue, payment] `[inferred]` ✓

## GraphQL

### QUERY
- `name`

## WebSocket Events

- `WS` `eventName` — `src/detectors/graphql.ts`
- `WS-ROOM` `room` — `src/detectors/graphql.ts`
- `WS` `room:*` — `src/detectors/graphql.ts`

---

# Libraries

- `src/ast/extract-android.ts`
  - function extractRetrofitRoutes: (filePath, content, tags) => RouteInfo[]
  - function extractRoomEntities: (_filePath, content) => SchemaModel[]
  - function extractComposeComponents: (filePath, content) => ComponentInfo[]
  - function extractNavigationRoutes: (filePath, content) => RouteInfo[]
  - function extractActivitiesFromManifest: (filePath, content) => RouteInfo[]
- `src/ast/extract-brighterscript.ts` — function extractBrighterScriptImports: (content) => string[], function extractBrighterScriptExports: (content) => ExportItem[]
- `src/ast/extract-brightscript.ts`
  - function extractBrightScriptFunctions: (content) => ExportItem[]
  - function extractBrightScriptObservers: (content) => BrightScriptObserver[]
  - function extractBrightScriptNavigationCalls: (content, helperNames) => ShowScreenCall[]
  - function extractBrightScriptShowScreenCalls: (content) => ShowScreenCall[]
  - function extractBrightScriptGraphqlCalls: (content) => GraphqlCallSite[]
  - function extractBrightScriptGlobalFields: (content) => GlobalFieldRegistration[]
  - _...7 more_
- `src/ast/extract-components.ts`
  - function extractReactComponentsAST: (ts, filePath, content, relPath) => ComponentInfo[]
  - function ComponentName: (...) => void
  - function ComponentName
- `src/ast/extract-csharp.ts`
  - function extractAspNetControllerRoutes: (filePath, content, tags) => RouteInfo[]
  - function extractAspNetMinimalApiRoutes: (filePath, content, tags) => RouteInfo[]
  - function extractEntityFrameworkModels: (_filePath, content) => SchemaModel[]
  - function extractCSharpExports: (content) => ExportItem[]
- `src/ast/extract-dart.ts`
  - function extractFlutterRoutes: (filePath, content, tags) => RouteInfo[]
  - function extractFlutterWidgets: (filePath, content) => ComponentInfo[]
  - function extractDartExports: (content) => ExportItem[]
- `src/ast/extract-go.ts`
  - function extractGoRoutesStructured: (filePath, content, framework, tags) => RouteInfo[]
  - function extractGORMModelsStructured: (_filePath, content) => SchemaModel[]
  - function extractEntSchemasStructured: (_filePath, content) => SchemaModel[]
- `src/ast/extract-php.ts`
  - function extractLaravelRoutes: (filePath, content, tags) => RouteInfo[]
  - function extractEloquentModels: (_filePath, content) => SchemaModel[]
  - function extractPhpExports: (content) => ExportItem[]
- `src/ast/extract-python.ts`
  - function extractPythonRoutesAST: (filePath, content, framework, tags) => Promise<RouteInfo[] | null>
  - function extractSQLAlchemyAST: (filePath, content) => Promise<SchemaModel[] | null>
  - function extractDjangoModelsAST: (filePath, content) => Promise<SchemaModel[] | null>
  - function extractSQLModelAST: (filePath, content) => Promise<SchemaModel[] | null>
  - function isPythonAvailable: () => Promise<boolean>
- `src/ast/extract-routes.ts` — function extractRoutesAST: (ts, filePath, content, framework, tags) => RouteInfo[]
- `src/ast/extract-scenegraph.ts`
  - function extractSceneGraphComponent: (content) => SceneGraphComponent | null
  - function extractMainSceneScreens: (content) => Record<string, string>
  - function isSceneGraphXml: (content) => boolean
  - interface SceneGraphComponent
- `src/ast/extract-schema.ts` — function extractDrizzleSchemaAST: (ts, filePath, content) => SchemaModel[], function extractTypeORMSchemaAST: (ts, filePath, content) => SchemaModel[]
- `src/ast/extract-swift.ts`
  - function extractVaporRoutes: (filePath, content, tags) => RouteInfo[]
  - function extractSwiftUIViews: (filePath, content) => ComponentInfo[]
  - function extractSwiftExports: (content) => ExportItem[]
- `src/ast/loader.ts`
  - function loadTypeScript: (projectRoot) => any | null
  - function resetCache: () => void
  - function parseSourceFile: (ts, fileName, content) => any
  - function getDecorators: (ts, node) => any[]
  - function parseDecorator: (ts, sf, decorator) => void
  - function getText: (sf, node) => string
- `src/config.ts` — function loadConfig: (root) => Promise<CodesightConfig>, function mergeCliConfig: (config, cli) => CodesightConfig
- `src/core.ts`
  - function scan: (root, outputDirName, maxDepth, userConfig, quiet) => Promise<ScanResult>
  - const VERSION: string
  - const BRAND
- `src/detectors/blast-radius.ts` — function analyzeBlastRadius: (filePath, result, maxDepth) => BlastRadiusResult, function analyzeMultiFileBlastRadius: (files, result, maxDepth) => BlastRadiusResult
- `src/detectors/components.ts` — function detectComponents: (files, project) => Promise<ComponentInfo[]>, function ComponentName: (starts with uppercase) => void
- `src/detectors/config.ts` — function detectConfig: (files, project) => Promise<ConfigInfo>
- `src/detectors/contracts.ts` — function enrichRouteContracts: (routes, project) => Promise<RouteInfo[]>
- `src/detectors/coverage.ts` — function isTestFile: (file) => boolean, function detectTestCoverage: (files, routes, schemas, projectRoot) => Promise<TestCoverage>
- `src/detectors/events.ts` — function detectEvents: (files, project) => Promise<EventInfo[]>
- `src/detectors/graph.ts` — function detectDependencyGraph: (files, project) => Promise<DependencyGraph>
- `src/detectors/graphql.ts`
  - function detectGraphQLRoutes: (files, project) => Promise<RouteInfo[]>
  - function detectGRPCRoutes: (files, project) => Promise<RouteInfo[]>
  - function detectWebSocketRoutes: (files, project) => Promise<RouteInfo[]>
- `src/detectors/knowledge.ts` — function detectKnowledge: (files, root) => Promise<KnowledgeMap>
- `src/detectors/libs.ts`
  - function detectLibs: (files, project) => Promise<LibExport[]>
  - function name: (params) => returnType
  - function name
  - class Name
  - interface Name
  - type Name
  - _...2 more_
- `src/detectors/middleware.ts` — function detectMiddleware: (files, project) => Promise<MiddlewareInfo[]>
- `src/detectors/openapi.ts` — function detectOpenAPISpec: (root, project) => Promise<OpenAPIResult>, interface OpenAPIResult
- `src/detectors/routes.ts` — function detectRoutes: (files, project, config?) => Promise<RouteInfo[]>, const GET
- `src/detectors/schema.ts` — function detectSchemas: (files, project) => Promise<SchemaModel[]>, const users
- `src/detectors/tokens.ts` — function estimateTokens: (text) => number, function calculateTokenStats: (result, outputText, fileCount) => import("../types.js").TokenStats
- `src/eval.ts` — function runEval: () => Promise<void>
- `src/formatter.ts`
  - function writeOutput: (result, outputDir) => Promise<string>
  - function computeCrudGroups: (routes) => import("./types.js").CrudGroup[]
  - function formatKnowledge: (map, projectName, version) => string
  - function writeKnowledgeOutput: (map, outputDir, projectName, version) => Promise<string>
- `src/generators/ai-config.ts`
  - function generateAIConfigs: (result, root) => Promise<string[]>
  - function generateProfileConfig: (result, root, profile) => Promise<string>
  - function generateMonorepoAIConfigs: (root, packages, outputDirName) => Promise<string[]>
- `src/generators/html-report.ts` — function generateHtmlReport: (result, outputDir) => Promise<string>
- `src/generators/wiki.ts`
  - function generateWiki: (result, outputDir) => Promise<WikiResult>
  - function readWikiArticle: (outputDir, article) => Promise<string | null>
  - function listWikiArticles: (outputDir) => Promise<string[]>
  - function lintWiki: (result, outputDir) => Promise<string>
  - interface WikiResult
- `src/mcp-server.ts` — function startMCPServer: () => void
- `src/monorepo/deps.ts` — function extractCrossPackageDeps: (packageDir, workspacePackageNames) => Promise<string[]>, function writeDepsFile: (packageDir, deps, outputDirName) => Promise<void>
- `src/monorepo/discover.ts` — function discoverPackages: (root, config) => Promise<PackageInfo[]>, interface PackageInfo
- `src/monorepo/orchestrator.ts` — function runMonorepoScan: (root, userConfig, targetPackage?) => Promise<PackageInfo[]>
- `src/monorepo/watch.ts` — function watchMonorepo: (root, userConfig) => Promise<void>
- `src/plugins/cicd/circleci.ts` — function extractCircleCIWorkflows: (parsed, relPath, rawContent) => CICDPipeline[]
- `src/plugins/cicd/formatter.ts` — function formatCICD: (pipelines) => string
- `src/plugins/cicd/github-actions.ts` — function extractGitHubActionsWorkflow: (parsed, relPath, rawContent) => CICDPipeline | null
- `src/plugins/cicd/index.ts` — function createCICDPlugin: (config) => CodesightPlugin, interface CICDPluginConfig
- `src/plugins/cicd/yaml-parser.ts` — function parseYAML: (text) => any, function parseFlowSequence: (s) => any[]
- `src/plugins/githooks/formatter.ts` — function formatGitHooks: (hooks) => string
- `src/plugins/githooks/husky.ts` — function parseHusky: (root) => Promise<GitHook[]>
- `src/plugins/githooks/index.ts` — function createGitHooksPlugin: () => CodesightPlugin
- `src/plugins/githooks/lefthook.ts` — function parseLefthook: (root) => Promise<GitHook[]>
- `src/plugins/githooks/raw.ts` — function parseRawHooks: (root) => Promise<GitHook[]>
- `src/plugins/skills/formatter.ts` — function formatSkills: (skills) => string
- `src/plugins/skills/index.ts` — function createSkillsPlugin: () => CodesightPlugin, interface Skill
- `src/plugins/terraform/extractor.ts` — function extractServiceInfrastructure: (matchedBlocks, allBlocks, config) => ServiceInfrastructure, function extractEnvironments: (tfvarsFiles, serviceName) => Promise<Record<string, EnvironmentOverrides>>
- `src/plugins/terraform/file-collector.ts`
  - function collectTfFiles: (projectRoot, config) => Promise<CollectedFiles>
  - function readFileSafe: (path) => Promise<string>
  - interface CollectedFiles
- `src/plugins/terraform/formatter.ts` — function formatInfrastructure: (infra) => string
- `src/plugins/terraform/hcl-parser.ts`
  - function parseHclFile: (content, filePath) => HclBlock[]
  - function parseTfvars: (content) => Record<string, string>
  - function stripComments: (content) => string
  - function extractBraceBlock: (content, startAfterOpenBrace) => string | null
- `src/plugins/terraform/index.ts` — function createTerraformPlugin: (config) => CodesightPlugin
- `src/plugins/terraform/service-matcher.ts`
  - function matchServiceBlocks: (projectName, blocks, config) => HclBlock[]
  - function normaliseServiceName: (name) => string
  - interface ScoredBlock
- `src/scanner.ts`
  - function readCodesightIgnore: (root) => Promise<string[]>
  - function loadFileHashCache: (outputDir) => Promise<FileHashCache>
  - function saveFileHashCache: (outputDir, cache) => Promise<void>
  - function hashFileContent: (content) => string
  - function collectFiles: (root, maxDepth, ignorePatterns) => Promise<string[]>
  - function readFileSafe: (path) => Promise<string>
  - _...5 more_
- `src/telemetry.ts`
  - function runTelemetry: (root, result, outputDir) => Promise<TelemetryReport>
  - interface TelemetryTask
  - interface TelemetryReport

---

# Config

## Environment Variables

- `DATABASE_URL` **required** — tests/detectors.test.ts
- `PORT` **required** — tests/detectors.test.ts
- `VAR` **required** — src/detectors/config.ts
- `VAR_NAME` **required** — src/detectors/config.ts
- `VITE_VAR_NAME` **required** — src/detectors/config.ts

## Config Files

- `tsconfig.json`

---

# Middleware

## auth
- middleware — `src/detectors/middleware.ts`

---

# Dependency Graph

## Most Imported Files (change these carefully)

- `src/types.ts` — imported by **48** files
- `src/scanner.ts` — imported by **16** files
- `src/ast/loader.ts` — imported by **6** files
- `src/plugins/terraform/types.ts` — imported by **6** files
- `src/ast/extract-brightscript.ts` — imported by **5** files
- `src/plugins/cicd/types.ts` — imported by **5** files
- `src/plugins/githooks/types.ts` — imported by **5** files
- `src/detectors/routes.ts` — imported by **3** files
- `src/detectors/schema.ts` — imported by **3** files
- `src/detectors/components.ts` — imported by **3** files
- `src/detectors/config.ts` — imported by **3** files
- `src/detectors/middleware.ts` — imported by **3** files
- `src/formatter.ts` — imported by **3** files
- `src/ast/extract-dart.ts` — imported by **3** files
- `src/ast/extract-swift.ts` — imported by **3** files
- `src/ast/extract-android.ts` — imported by **3** files
- `src/ast/extract-scenegraph.ts` — imported by **3** files
- `src/ast/extract-csharp.ts` — imported by **3** files
- `src/ast/extract-php.ts` — imported by **3** files
- `src/generators/ai-config.ts` — imported by **3** files

## Import Map (who imports what)

- `src/types.ts` ← `src/ast/extract-android.ts`, `src/ast/extract-brighterscript.ts`, `src/ast/extract-brightscript.ts`, `src/ast/extract-components.ts`, `src/ast/extract-csharp.ts` +43 more
- `src/scanner.ts` ← `src/core.ts`, `src/detectors/components.ts`, `src/detectors/config.ts`, `src/detectors/contracts.ts`, `src/detectors/coverage.ts` +11 more
- `src/ast/loader.ts` ← `src/ast/extract-components.ts`, `src/ast/extract-routes.ts`, `src/ast/extract-schema.ts`, `src/detectors/components.ts`, `src/detectors/routes.ts` +1 more
- `src/plugins/terraform/types.ts` ← `src/plugins/terraform/file-collector.ts`, `src/plugins/terraform/formatter.ts`, `src/plugins/terraform/hcl-parser.ts`, `src/plugins/terraform/index.ts`, `src/plugins/terraform/index.ts` +1 more
- `src/ast/extract-brightscript.ts` ← `src/ast/extract-brighterscript.ts`, `src/detectors/events.ts`, `src/detectors/libs.ts`, `src/detectors/middleware.ts`, `src/detectors/routes.ts`
- `src/plugins/cicd/types.ts` ← `src/plugins/cicd/circleci.ts`, `src/plugins/cicd/formatter.ts`, `src/plugins/cicd/github-actions.ts`, `src/plugins/cicd/index.ts`, `src/plugins/cicd/index.ts`
- `src/plugins/githooks/types.ts` ← `src/plugins/githooks/formatter.ts`, `src/plugins/githooks/husky.ts`, `src/plugins/githooks/index.ts`, `src/plugins/githooks/lefthook.ts`, `src/plugins/githooks/raw.ts`
- `src/detectors/routes.ts` ← `src/core.ts`, `src/eval.ts`, `src/mcp-server.ts`
- `src/detectors/schema.ts` ← `src/core.ts`, `src/eval.ts`, `src/mcp-server.ts`
- `src/detectors/components.ts` ← `src/core.ts`, `src/eval.ts`, `src/mcp-server.ts`

---

# Events & Queues

## bullmq

- `queue-name` [queue] — `src/detectors/events.ts`
- `job-name` [queue] — `src/detectors/events.ts`

## kafka

- `name` [topic] — `src/detectors/events.ts`

## redis-pub-sub

- `channel` [channel] — `src/detectors/events.ts`

## eventemitter

- `event-name` [event] — `src/detectors/events.ts`
- `) || content.includes(` [event] — `src/detectors/events.ts`

---

# Test Coverage

> **60%** of routes and models are covered by tests
> 20 test files found

## Covered Routes

- ALL:/health
- GET:/api/users
- QUERY:name

---

_Generated by [codesight](https://github.com/Houseofmvps/codesight) — see your codebase clearly_
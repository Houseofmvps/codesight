export type Framework =
  | "next-app"
  | "next-pages"
  | "hono"
  | "express"
  | "fastify"
  | "koa"
  | "nestjs"
  | "elysia"
  | "adonis"
  | "trpc"
  | "sveltekit"
  | "remix"
  | "nuxt"
  | "flask"
  | "fastapi"
  | "django"
  | "celery"
  | "go-net-http"
  | "gin"
  | "fiber"
  | "echo"
  | "chi"
  | "rails"
  | "phoenix"
  | "spring"
  | "ktor"
  | "actix"
  | "axum"
  | "raw-http"
  | "php"
  | "laravel"
  | "aspnet"
  | "vapor"
  | "swiftui"
  | "flutter"
  | "android"
  | "roku-scenegraph"
  | "graphql"
  | "grpc"
  | "websocket"
  | "angular"
  | "unknown";

export type ORM = "drizzle" | "prisma" | "typeorm" | "sqlalchemy" | "django" | "gorm" | "ent" | "mongoose" | "sequelize" | "activerecord" | "ecto" | "eloquent" | "entity-framework" | "exposed" | "room" | "scenegraph" | "unknown";

export type ComponentFramework = "react" | "vue" | "svelte" | "flutter" | "jetpack-compose" | "angular" | "scenegraph" | "unknown";


export type KnowledgeNoteType = "decision" | "meeting" | "retro" | "spec" | "backlog" | "research" | "session" | "general";

export interface KnowledgeNote {
  file: string;
  title: string;
  type: KnowledgeNoteType;
  date?: string;
  tags: string[];
  summary: string;
  decisions: string[];
  openQuestions: string[];
  people: string[];
  backlinks?: number; // incoming wikilink/markdown-link references from other notes
}

export interface KnowledgeMap {
  notes: KnowledgeNote[];
  totalNotes: number;
  decisions: string[];
  openQuestions: string[];
  recurringThemes: string[];
  people: string[];
  projects: string[];
  hubNotes?: { file: string; title: string; refs: number }[];
  dateRange?: { from: string; to: string };
}

export type RepoType = "single" | "monorepo" | "microservices" | "meta";

export interface ProjectInfo {
  root: string;
  name: string;
  frameworks: Framework[];
  orms: ORM[];
  componentFramework: ComponentFramework;
  isMonorepo: boolean;
  repoType: RepoType;
  workspaces: WorkspaceInfo[];
  language: "typescript" | "javascript" | "python" | "go" | "ruby" | "elixir" | "java" | "kotlin" | "rust" | "php" | "dart" | "swift" | "csharp" | "brightscript" | "mixed";
}

export interface WorkspaceInfo {
  name: string;
  path: string;
  frameworks: Framework[];
  orms: ORM[];
}

export type DetectionMethod = "ast" | "regex";

export interface RouteInfo {
  method: string;
  path: string;
  file: string;
  tags: string[];
  framework: Framework;
  requestType?: string;
  responseType?: string;
  params?: string[];
  confidence?: DetectionMethod;
  middleware?: string[];
}

export interface SchemaModel {
  name: string;
  fields: SchemaField[];
  relations: string[];
  orm: ORM;
  confidence?: DetectionMethod;
}

export interface SchemaField {
  name: string;
  type: string;
  flags: string[]; // pk, fk, unique, nullable, default
}

export interface ComponentInfo {
  name: string;
  file: string;
  confidence?: DetectionMethod;
  props: string[];
  isClient: boolean;
  isServer: boolean;
}

export interface LibExport {
  file: string;
  exports: ExportItem[];
}

export interface ExportItem {
  name: string;
  kind: "function" | "class" | "const" | "type" | "interface" | "enum";
  signature?: string;
}

export interface ConfigInfo {
  envVars: EnvVar[];
  configFiles: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export interface EnvVar {
  name: string;
  source: string;
  hasDefault: boolean;
}

export interface MiddlewareInfo {
  name: string;
  file: string;
  type: "auth" | "rate-limit" | "cors" | "validation" | "logging" | "error-handler" | "custom";
}

export interface ImportEdge {
  from: string; // file that imports
  to: string;   // file being imported
}

export interface DependencyGraph {
  edges: ImportEdge[];
  hotFiles: { file: string; importedBy: number }[]; // most-imported files
}

export interface BlastRadiusResult {
  file: string;
  affectedFiles: string[];
  affectedRoutes: RouteInfo[];
  affectedModels: string[];
  affectedMiddleware: string[];
  depth: number;
}

export interface MonorepoConfig {
  enabled?: boolean;
  workspaceFile?: string;  // default: "pnpm-workspace.yaml"
  minFiles?: number;       // default: 10
  exclude?: string[];      // force-skip by package name
  include?: string[];      // force-include despite filter
}

export interface CodesightConfig {
  /** Disable specific detectors: "routes", "schema", "components", "libs", "config", "middleware", "graph", "graphql", "events" */
  disableDetectors?: string[];
  /** Custom route tags: { "billing": ["stripe", "payment"] } */
  customTags?: Record<string, string[]>;
  /** Max directory depth (default: 10) */
  maxDepth?: number;
  /** Output directory name (default: ".codesight") */
  outputDir?: string;
  /** AI tool profile */
  profile?: "claude-code" | "cursor" | "codex" | "copilot" | "windsurf" | "agents" | "generic";
  /** Additional ignore patterns (glob-style) */
  ignorePatterns?: string[];
  /** Custom route patterns: [{ pattern: "router\\.handle\\(", method: "ALL" }] */
  customRoutePatterns?: { pattern: string; method?: string }[];
  /** Blast radius max BFS depth (default: 5) */
  blastRadiusDepth?: number;
  /** Hot file threshold: min imports to be "hot" (default: 3) */
  hotFileThreshold?: number;
  /** Max output tokens — intelligently trims lower-importance items to fit budget */
  maxTokens?: number;
  /** Collapse standard CRUD route groups into single summary lines (default: true) */
  collapseCrud?: boolean;
  /** Plugin hooks */
  plugins?: CodesightPlugin[];
  /** Monorepo configuration */
  monorepo?: MonorepoConfig;
  /**
   * Roku only: helper names used in BRS to open a screen/view. Defaults to
   * ["ShowScreen", "showScreen", "pushScreen", "PushScreen", "NavigateTo",
   *  "navigateTo", "showView", "ShowView"]. Override when your project uses
   * a different navigation helper convention.
   */
  rokuScreenHelpers?: string[];
}

export interface CodesightPlugin {
  /** Plugin name for identification */
  name: string;
  /** Custom detector: runs after built-in detectors */
  detector?: (files: string[], project: ProjectInfo) => Promise<PluginDetectorResult>;
  /** Post-processor: transforms the final ScanResult */
  postProcessor?: (result: ScanResult) => Promise<ScanResult>;
}

export interface PluginDetectorResult {
  /** Additional routes to merge */
  routes?: RouteInfo[];
  /** Additional schema models to merge */
  schemas?: SchemaModel[];
  /** Additional components to merge */
  components?: ComponentInfo[];
  /** Additional middleware to merge */
  middleware?: MiddlewareInfo[];
}

export interface EventInfo {
  name: string;
  type: "queue" | "topic" | "event" | "channel";
  system: "bullmq" | "kafka" | "redis-pub-sub" | "socket.io" | "eventemitter" | "celery" | "scenegraph-observer" | "rudderstack" | "unknown";
  file: string;
  payloadType?: string;
}

export interface CrudGroup {
  resource: string;   // e.g. "/users"
  methods: string[];  // e.g. ["GET", "POST", "GET/:id", "PUT/:id", "DELETE/:id"]
  modelHint?: string; // e.g. "User"
}

export interface TestCoverage {
  testedRoutes: string[];   // "METHOD:path" keys
  testedModels: string[];
  testFiles: string[];
  coveragePercent: number;
}

export interface ScanResult {
  project: ProjectInfo;
  routes: RouteInfo[];
  schemas: SchemaModel[];
  components: ComponentInfo[];
  libs: LibExport[];
  config: ConfigInfo;
  middleware: MiddlewareInfo[];
  graph: DependencyGraph;
  tokenStats: TokenStats;
  events?: EventInfo[];
  testCoverage?: TestCoverage;
  crudGroups?: CrudGroup[];
}

export interface TokenStats {
  outputTokens: number;
  estimatedExplorationTokens: number;
  saved: number;
  fileCount: number;
}

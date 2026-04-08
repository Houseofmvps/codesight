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
  | "go-net-http"
  | "gin"
  | "fiber"
  | "echo"
  | "chi"
  | "rails"
  | "phoenix"
  | "spring"
  | "actix"
  | "axum"
  | "raw-http"
  | "php"
  | "laravel"
  | "aspnet"
  | "vapor"
  | "swiftui"
  | "flutter"
  | "unknown";

export type ORM = "drizzle" | "prisma" | "typeorm" | "sqlalchemy" | "gorm" | "mongoose" | "sequelize" | "activerecord" | "ecto" | "eloquent" | "entity-framework" | "unknown";

export type ComponentFramework = "react" | "vue" | "svelte" | "flutter" | "unknown";

export interface ProjectInfo {
  root: string;
  name: string;
  frameworks: Framework[];
  orms: ORM[];
  componentFramework: ComponentFramework;
  isMonorepo: boolean;
  workspaces: WorkspaceInfo[];
  language: "typescript" | "javascript" | "python" | "go" | "ruby" | "elixir" | "java" | "kotlin" | "rust" | "php" | "dart" | "swift" | "csharp" | "mixed";
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

export interface CodesightConfig {
  /** Disable specific detectors: "routes", "schema", "components", "libs", "config", "middleware", "graph" */
  disableDetectors?: string[];
  /** Custom route tags: { "billing": ["stripe", "payment"] } */
  customTags?: Record<string, string[]>;
  /** Max directory depth (default: 10) */
  maxDepth?: number;
  /** Output directory name (default: ".codesight") */
  outputDir?: string;
  /** AI tool profile */
  profile?: "claude-code" | "cursor" | "codex" | "copilot" | "windsurf" | "generic";
  /** Additional ignore patterns (glob-style) */
  ignorePatterns?: string[];
  /** Custom route patterns: [{ pattern: "router\\.handle\\(", method: "ALL" }] */
  customRoutePatterns?: { pattern: string; method?: string }[];
  /** Blast radius max BFS depth (default: 5) */
  blastRadiusDepth?: number;
  /** Hot file threshold: min imports to be "hot" (default: 3) */
  hotFileThreshold?: number;
  /** Plugin hooks */
  plugins?: CodesightPlugin[];
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
}

export interface TokenStats {
  outputTokens: number;
  estimatedExplorationTokens: number;
  saved: number;
  fileCount: number;
}

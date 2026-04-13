/** User-facing configuration for the Terraform infrastructure plugin */
export interface TerraformPluginConfig {
  /** Path to infra repo — absolute or relative to project root.
   *  Default: auto-discovers ../infrastructure, ./terraform, ./infra, ./deploy */
  infraPath?: string;
  /** Override service name matching (default: project.name from package.json etc.) */
  serviceName?: string;
  /** Additional name patterns to match against resource labels */
  serviceAliases?: string[];
  /** Scan environments/*.tfvars for per-env overrides (default: true) */
  scanEnvironments?: boolean;
}

/** A parsed HCL top-level block */
export interface HclBlock {
  /** "resource" | "module" | "data" | "variable" | "output" | "locals" | "provider" */
  blockType: string;
  /** For resource/data: the resource type (e.g. "aws_ecs_service"). For module/variable/output: same as label. */
  resourceType: string;
  /** The resource/module name label */
  label: string;
  /** Source .tf file (relative path) */
  file: string;
  /** Top-level key=value attributes (values kept as raw strings, not evaluated) */
  attributes: Record<string, string>;
  /** Named nested blocks, e.g. { "tags": [{ key: "Name", value: "..." }] } */
  nestedBlocks: Record<string, NestedBlock[]>;
}

export interface NestedBlock {
  attributes: Record<string, string>;
}

/** Extracted infrastructure context for one service */
export interface ServiceInfrastructure {
  serviceName: string;
  sourceFiles: string[];
  components: ServiceComponent[];
  dns: DnsConfig;
  envVars: EnvVar[];
  secrets: SecretRef[];
  dependencies: string[];
  iamPermissions: string[];
  observability: ObservabilityConfig;
  environments: Record<string, EnvironmentOverrides>;
}

export interface ServiceComponent {
  label: string;
  deploymentType: string;
  moduleSource?: string;
  compute?: { cpu?: string; memory?: string; desiredCount?: string };
  healthCheck?: string;
  enableFlag?: string;
  isPublicFacing: boolean;
}

export interface DnsConfig {
  hostnames: string[];
  isPublicFacing: boolean;
}

export interface EnvVar {
  name: string;
  value: string;
  source: "literal" | "variable" | "reference";
}

export interface SecretRef {
  name: string;
  arnPattern: string;
}

export interface ObservabilityConfig {
  logGroup?: string;
  alarms: string[];
}

export interface EnvironmentOverrides {
  enabled?: boolean;
  variables: Record<string, string>;
}

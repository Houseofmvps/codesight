import { basename } from "node:path";
import { normaliseServiceName } from "./service-matcher.js";
import { parseTfvars } from "./hcl-parser.js";
import { readFileSafe } from "./file-collector.js";
import type {
  HclBlock,
  ServiceInfrastructure,
  ServiceComponent,
  DnsConfig,
  EnvVar,
  SecretRef,
  ObservabilityConfig,
  EnvironmentOverrides,
  TerraformPluginConfig,
} from "./types.js";

/**
 * Extract structured infrastructure context from matched HCL blocks.
 */
export function extractServiceInfrastructure(
  matchedBlocks: HclBlock[],
  allBlocks: HclBlock[],
  config: TerraformPluginConfig,
): ServiceInfrastructure {
  const serviceName = config.serviceName ?? "unknown";
  const sourceFiles = [...new Set(matchedBlocks.map((b) => b.file))];

  const components = extractComponents(matchedBlocks);
  const envVars = extractEnvVars(matchedBlocks);
  const secrets = extractSecrets(matchedBlocks);
  const dns = extractDns(matchedBlocks);
  const dependencies = extractDependencies(matchedBlocks, allBlocks);
  const iamPermissions = extractIamPermissions(matchedBlocks);
  const observability = extractObservability(matchedBlocks, allBlocks, serviceName);

  return {
    serviceName,
    sourceFiles,
    components,
    dns,
    envVars,
    secrets,
    dependencies,
    iamPermissions,
    observability,
    environments: {},
  };
}

/**
 * Parse .tfvars files and extract per-environment overrides for this service.
 */
export async function extractEnvironments(
  tfvarsFiles: string[],
  serviceName: string,
): Promise<Record<string, EnvironmentOverrides>> {
  const environments: Record<string, EnvironmentOverrides> = {};
  const normalised = normaliseServiceName(serviceName);

  // TODO: consider Promise.all for parallel file reads in large infra repos
  for (const file of tfvarsFiles) {
    const envName = basename(file, ".tfvars");
    const content = await readFileSafe(file);
    if (!content) continue;

    const vars = parseTfvars(content);
    const matched: Record<string, string> = {};
    let enabled: boolean | undefined;

    for (const [key, value] of Object.entries(vars)) {
      const normalisedKey = normaliseServiceName(key);

      // Check enable flag
      if (normalisedKey.startsWith(`enable_${normalised}`)) {
        enabled = value === "true";
        matched[key] = value;
        continue;
      }

      // Check if variable name contains the service name
      if (normalisedKey.includes(normalised)) {
        matched[key] = value;
      }
    }

    if (Object.keys(matched).length > 0 || enabled !== undefined) {
      environments[envName] = { enabled, variables: matched };
    }
  }

  return environments;
}

// ─── Component Extraction ───

function extractComponents(blocks: HclBlock[]): ServiceComponent[] {
  const components: ServiceComponent[] = [];

  for (const block of blocks) {
    if (block.blockType !== "module" && block.blockType !== "resource") continue;
    // Skip variable/output blocks — they're metadata not components
    if (block.blockType === "resource" && !isComputeResource(block.resourceType)) continue;

    // Skip non-compute modules (alarms, s3, logging, etc.)
    if (block.blockType === "module" && !isComputeModule(block)) continue;

    const moduleSource = block.attributes["source"];
    const deploymentType = inferDeploymentType(moduleSource, block.resourceType);
    const isPublicFacing = detectPublicFacing(block);

    components.push({
      label: block.label,
      deploymentType,
      moduleSource,
      compute: {
        cpu: block.attributes["cpu"],
        memory: block.attributes["memory"],
        desiredCount: block.attributes["desired_count"],
      },
      healthCheck: extractHealthCheck(block),
      enableFlag: extractEnableFlag(block),
      isPublicFacing,
    });
  }

  return components;
}

function isComputeResource(resourceType: string): boolean {
  return [
    "aws_ecs_service",
    "aws_ecs_task_definition",
    "aws_lambda_function",
    "aws_instance",
    "aws_autoscaling_group",
  ].includes(resourceType);
}

function isComputeModule(block: HclBlock): boolean {
  const source = block.attributes["source"] ?? "";
  // Positive: compute modules
  if (source.includes("ecs-service") || source.includes("ecs-worker") || source.includes("lambda")) return true;
  // Negative: known non-compute modules
  if (source.includes("alarm") || source.includes("logging") || source.includes("s3") ||
      source.includes("autoscaling") || source.includes("kms") || source.includes("secret") ||
      source.includes("iam") || source.includes("deploy")) return false;
  // Heuristic: modules with image attribute are likely compute
  if (block.attributes["image"] || block.attributes["container_image"]) return true;
  // Default: include if it has cpu/memory (likely compute)
  if (block.attributes["cpu"] || block.attributes["memory"]) return true;
  return false;
}

function inferDeploymentType(moduleSource: string | undefined, resourceType: string): string {
  if (moduleSource) {
    if (moduleSource.includes("ecs-service")) return "ecs-fargate";
    if (moduleSource.includes("ecs-worker")) return "ecs-worker";
    if (moduleSource.includes("ecs-service-internal")) return "ecs-internal";
    if (moduleSource.includes("lambda")) return "lambda";
    if (moduleSource.includes("ec2") || moduleSource.includes("instance")) return "ec2";
  }
  if (resourceType.includes("lambda")) return "lambda";
  if (resourceType.includes("ecs")) return "ecs-fargate";
  if (resourceType.includes("instance")) return "ec2";
  return "unknown";
}

function detectPublicFacing(block: HclBlock): boolean {
  const attrs = block.attributes;
  if (attrs["alb_listener_arn"] || attrs["https_listener_arn"]) return true;
  if (attrs["host_headers"]) return true;

  // Check if any attribute references an ALB
  for (const val of Object.values(attrs)) {
    if (typeof val === "string" && val.includes("module.alb")) return true;
  }

  // Internal service modules are not public-facing
  const source = attrs["source"] ?? "";
  if (source.includes("ecs-worker") || source.includes("ecs-service-internal")) return false;

  return false;
}

function extractHealthCheck(block: HclBlock): string | undefined {
  if (block.attributes["health_check_path"]) return block.attributes["health_check_path"];

  const healthCheck = block.nestedBlocks["health_check"];
  if (healthCheck?.[0]?.attributes["path"]) return healthCheck[0].attributes["path"];

  return undefined;
}

function extractEnableFlag(block: HclBlock): string | undefined {
  const count = block.attributes["count"];
  if (!count) return undefined;

  const match = count.match(/var\.(\w+)/);
  return match ? `var.${match[1]}` : undefined;
}

// ─── Environment Variables ───

function extractEnvVars(blocks: HclBlock[]): EnvVar[] {
  const envVars: EnvVar[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const entries = block.nestedBlocks["environment_variables"] ?? block.nestedBlocks["environment"];
    if (!entries) continue;

    for (const entry of entries) {
      const name = entry.attributes["name"];
      const value = entry.attributes["value"] ?? entry.attributes["valueFrom"] ?? "";
      if (!name || seen.has(name)) continue;
      seen.add(name);

      envVars.push({
        name,
        value,
        source: classifyValueSource(value),
      });
    }
  }

  return envVars;
}

function classifyValueSource(value: string): "literal" | "variable" | "reference" {
  if (value.startsWith("var.")) return "variable";
  if (value.includes("module.") || value.includes("aws_") || value.includes("data.")) return "reference";
  if (value.includes("${")) {
    // Interpolated string — check if it references vars or resources
    if (value.includes("${var.")) return "variable";
    if (value.includes("${module.") || value.includes("${data.") || value.includes("${aws_")) return "reference";
  }
  return "literal";
}

// ─── Secrets ───

function extractSecrets(blocks: HclBlock[]): SecretRef[] {
  const secrets: SecretRef[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const entries = block.nestedBlocks["secrets"];
    if (!entries) continue;

    for (const entry of entries) {
      const name = entry.attributes["name"];
      const arn = entry.attributes["valueFrom"] ?? entry.attributes["value_from"] ?? "";
      if (!name || seen.has(name)) continue;
      seen.add(name);

      secrets.push({ name, arnPattern: arn });
    }
  }

  return secrets;
}

// ─── DNS ───

function extractDns(blocks: HclBlock[]): DnsConfig {
  const hostnames: string[] = [];
  let isPublicFacing = false;

  for (const block of blocks) {
    // host_headers attribute (used in ECS service modules for ALB routing)
    const hostHeaders = block.attributes["host_headers"];
    if (hostHeaders) {
      // Parse list: ["host1", "host2"] or extract from ternary expressions
      const matches = hostHeaders.match(/"([^"]+)"/g);
      if (matches) {
        for (const m of matches) {
          const hostname = m.replace(/"/g, "");
          // Only include values that look like hostnames (contain a dot or interpolation)
          if (hostname.includes(".") || hostname.includes("${")) {
            hostnames.push(hostname);
          }
        }
      }
      isPublicFacing = true;
    }

    // Route53 record
    if (block.blockType === "resource" && block.resourceType === "aws_route53_record") {
      const name = block.attributes["name"];
      if (name && (name.includes(".") || name.includes("${"))) {
        hostnames.push(name);
      }
      isPublicFacing = true;
    }

    // ALB references
    if (block.attributes["alb_listener_arn"] || block.attributes["https_listener_arn"]) {
      isPublicFacing = true;
    }
  }

  return { hostnames: [...new Set(hostnames)], isPublicFacing };
}

// ─── Dependencies ───

function extractDependencies(matchedBlocks: HclBlock[], allBlocks: HclBlock[]): string[] {
  const deps = new Set<string>();

  for (const block of matchedBlocks) {
    // Scan all attribute values for module/resource references
    for (const [key, value] of Object.entries(block.attributes)) {
      if (key === "source" || key === "count") continue;

      // module.xxx references
      const moduleRefs = value.match(/module\.(\w+)/g);
      if (moduleRefs) {
        for (const ref of moduleRefs) {
          const moduleName = ref.replace("module.", "");
          const desc = describeModuleDep(moduleName, allBlocks);
          deps.add(desc);
        }
      }

      // data.xxx references
      const dataRefs = value.match(/data\.(\w+)\.(\w+)/g);
      if (dataRefs) {
        for (const ref of dataRefs) {
          deps.add(ref);
        }
      }

      // Service Connect references
      if (key.includes("service_connect") && value.includes("true")) {
        deps.add("ECS Service Connect");
      }
    }

    // Service Connect discovery name → dependency
    if (block.attributes["service_connect_discovery_name"]) {
      const svcName = block.attributes["service_connect_discovery_name"];
      deps.add(`Service Connect: ${svcName}`);
    }
  }

  return [...deps];
}

function describeModuleDep(moduleName: string, allBlocks: HclBlock[]): string {
  // Try to find the module definition to get its source for a friendlier name
  const moduleBlock = allBlocks.find(
    (b) => b.blockType === "module" && b.label === moduleName,
  );

  if (moduleBlock?.attributes["source"]) {
    const source = moduleBlock.attributes["source"];
    if (source.includes("rds") || source.includes("database")) return `RDS (module.${moduleName})`;
    if (source.includes("redis") || source.includes("elasticache")) return `Redis (module.${moduleName})`;
    if (source.includes("s3")) return `S3 (module.${moduleName})`;
    if (source.includes("sqs")) return `SQS (module.${moduleName})`;
    if (source.includes("sns")) return `SNS (module.${moduleName})`;
    if (source.includes("vpc")) return `VPC (module.${moduleName})`;
    if (source.includes("alb")) return `ALB (module.${moduleName})`;
    if (source.includes("efs")) return `EFS (module.${moduleName})`;
    if (source.includes("kms")) return `KMS (module.${moduleName})`;
    if (source.includes("dynamodb")) return `DynamoDB (module.${moduleName})`;
  }

  return `module.${moduleName}`;
}

// ─── IAM Permissions ───

function extractIamPermissions(blocks: HclBlock[]): string[] {
  const permissions: string[] = [];

  for (const block of blocks) {
    // task_policy_arns attribute
    const policyArns = block.attributes["task_policy_arns"];
    if (policyArns) {
      const refs = policyArns.match(/[\w.-]+/g);
      if (refs) {
        for (const ref of refs) {
          if (ref.includes("policy") || ref.includes("arn")) {
            permissions.push(ref);
          }
        }
      }
    }

    // Inline IAM policy statements
    const statements = block.nestedBlocks["statement"];
    if (statements) {
      for (const stmt of statements) {
        const actions = stmt.attributes["actions"] ?? stmt.attributes["action"];
        const resources = stmt.attributes["resources"] ?? stmt.attributes["resource"];
        if (actions) {
          const effect = stmt.attributes["effect"];
          const prefix = effect ? `${effect}: ` : "";
          permissions.push(`${prefix}${actions}${resources ? ` on ${resources}` : ""}`);
        }
      }
    }
  }

  return [...new Set(permissions)];
}

// ─── Observability ───

function extractObservability(
  matchedBlocks: HclBlock[],
  allBlocks: HclBlock[],
  serviceName: string,
): ObservabilityConfig {
  let logGroup: string | undefined;
  const alarms: string[] = [];
  const normalisedService = normaliseServiceName(serviceName);

  // Look for log_group attribute in matched blocks
  for (const block of matchedBlocks) {
    if (block.attributes["log_group"]) {
      logGroup = block.attributes["log_group"];
    }
  }

  // Search all blocks for alarm modules referencing this service
  for (const block of allBlocks) {
    if (block.blockType !== "module") continue;
    const source = block.attributes["source"] ?? "";
    if (!source.includes("alarm")) continue;

    // Check if this alarm references our service
    const allValues = Object.values(block.attributes).join(" ");
    if (allValues.includes(normalisedService) || allValues.includes(normalisedService.replace(/_/g, "-"))) {
      const alarmName = block.label;
      const threshold = block.attributes["threshold"] ?? "";
      const metric = block.attributes["metric_name"] ?? "";
      const desc = [alarmName, metric, threshold ? `threshold: ${threshold}` : ""].filter(Boolean).join(" — ");
      alarms.push(desc);
    }
  }

  // Look for CloudWatch log group resources matching the service
  for (const block of allBlocks) {
    if (block.blockType === "resource" && block.resourceType === "aws_cloudwatch_log_group") {
      const name = block.attributes["name"] ?? "";
      if (name.includes(normalisedService) || name.includes(normalisedService.replace(/_/g, "-"))) {
        logGroup = name;
      }
    }
  }

  return { logGroup, alarms };
}

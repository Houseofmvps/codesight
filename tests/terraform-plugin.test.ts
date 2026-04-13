import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FIXTURES = join(import.meta.dirname, "fixtures", "terraform");

// Import from dist — matches codesight's test convention
const { parseHclFile, parseTfvars, stripComments, extractBraceBlock } = await import(
  "../dist/plugins/terraform/hcl-parser.js"
);
const { matchServiceBlocks, normaliseServiceName } = await import(
  "../dist/plugins/terraform/service-matcher.js"
);
const { extractServiceInfrastructure, extractEnvironments } = await import(
  "../dist/plugins/terraform/extractor.js"
);
const { formatInfrastructure } = await import("../dist/plugins/terraform/formatter.js");
const { collectTfFiles } = await import("../dist/plugins/terraform/file-collector.js");

// ─── HCL Parser Tests ───

describe("HCL Parser", () => {
  describe("stripComments", () => {
    it("strips # comments", () => {
      const result = stripComments('name = "test" # this is a comment\n');
      assert.ok(!result.includes("this is a comment"));
      assert.ok(result.includes('name = "test"'));
    });

    it("strips // comments", () => {
      const result = stripComments('name = "test" // c-style comment\n');
      assert.ok(!result.includes("c-style comment"));
    });

    it("strips /* */ block comments", () => {
      const result = stripComments('before /* this_is_removed\ncomment */ after');
      assert.ok(!result.includes("this_is_removed"), "Block comment content should be stripped");
      assert.ok(result.includes("before"));
      assert.ok(result.includes("after"));
    });

    it("preserves # inside strings", () => {
      const result = stripComments('default = "color is #ff0000"\n');
      assert.ok(result.includes("#ff0000"));
    });

    it("preserves // inside strings", () => {
      const result = stripComments('default = "https://example.com"\n');
      assert.ok(result.includes("https://example.com"));
    });
  });

  describe("extractBraceBlock", () => {
    it("extracts simple block", () => {
      const content = '{ name = "test" }';
      const result = extractBraceBlock(content, 1);
      assert.ok(result !== null);
      assert.ok(result.includes('name = "test"'));
    });

    it("handles nested braces", () => {
      const content = '{ outer { inner = true } }';
      const result = extractBraceBlock(content, 1);
      assert.ok(result !== null);
      assert.ok(result.includes("inner = true"));
    });

    it("handles braces inside strings", () => {
      const content = '{ name = "value with { braces }" }';
      const result = extractBraceBlock(content, 1);
      assert.ok(result !== null);
      assert.ok(result.includes("{ braces }"));
    });

    it("returns null for unmatched braces", () => {
      const content = "{ name = true";
      const result = extractBraceBlock(content, 1);
      assert.equal(result, null);
    });
  });

  describe("parseHclFile", () => {
    it("parses simple-ecs-service fixture", async () => {
      const content = await readFile(join(FIXTURES, "simple-ecs-service", "app-service.tf"), "utf-8");
      const blocks = parseHclFile(content, "app-service.tf");

      // Should find: 2 variables, 2 modules, 1 resource
      const variables = blocks.filter((b: any) => b.blockType === "variable");
      const modules = blocks.filter((b: any) => b.blockType === "module");
      const resources = blocks.filter((b: any) => b.blockType === "resource");

      assert.equal(variables.length, 2, `Expected 2 variables, got ${variables.length}`);
      assert.equal(modules.length, 2, `Expected 2 modules, got ${modules.length}`);
      assert.equal(resources.length, 1, `Expected 1 resource, got ${resources.length}`);

      // Check module attributes
      const appModule = modules.find((m: any) => m.label === "app_service");
      assert.ok(appModule, "Should find app_service module");
      assert.equal(appModule.attributes.cpu, "512");
      assert.equal(appModule.attributes.memory, "1024");
      assert.equal(appModule.attributes.health_check_path, "/health");
      assert.equal(appModule.attributes.source, "./modules/compute/ecs-service");

      // Check environment_variables nested block
      const envVars = appModule.nestedBlocks.environment_variables;
      assert.ok(envVars, "Should have environment_variables");
      assert.ok(envVars.length >= 5, `Expected at least 5 env vars, got ${envVars.length}`);

      const svcName = envVars.find((e: any) => e.attributes.name === "SERVICE_NAME");
      assert.ok(svcName, "Should find SERVICE_NAME env var");
      assert.equal(svcName.attributes.value, "app-service");

      // Check secrets nested block
      const secrets = appModule.nestedBlocks.secrets;
      assert.ok(secrets, "Should have secrets");
      assert.equal(secrets.length, 3, `Expected 3 secrets, got ${secrets.length}`);
    });

    it("parses edge cases fixture", async () => {
      const content = await readFile(join(FIXTURES, "edge-cases", "complex.tf"), "utf-8");
      const blocks = parseHclFile(content, "complex.tf");

      // Should handle comments, heredocs, jsonencode, dynamic blocks, etc.
      assert.ok(blocks.length >= 7, `Expected at least 7 blocks, got ${blocks.length}`);

      // Find the heredoc resource
      const heredocBlock = blocks.find(
        (b: any) => b.blockType === "resource" && b.label === "with_heredoc",
      );
      assert.ok(heredocBlock, "Should find heredoc resource");
      assert.ok(
        heredocBlock.attributes.container_definitions,
        "Should have container_definitions attribute",
      );

      // String with hash should be preserved
      const trickyString = blocks.find((b: any) => b.label === "tricky_string");
      assert.ok(trickyString, "Should find tricky_string variable");
      assert.ok(
        trickyString.attributes.default.includes("#ff0000"),
        "Hash in string should be preserved",
      );

      // Nested blocks (ingress/egress)
      const sgBlock = blocks.find((b: any) => b.label === "nested_blocks");
      assert.ok(sgBlock, "Should find nested_blocks security group");
      assert.ok(sgBlock.nestedBlocks.ingress, "Should have ingress blocks");
      assert.equal(sgBlock.nestedBlocks.ingress.length, 2, "Should have 2 ingress blocks");
      assert.ok(sgBlock.nestedBlocks.egress, "Should have egress blocks");
    });
  });

  describe("parseTfvars", () => {
    it("parses key=value pairs", async () => {
      const content = await readFile(
        join(FIXTURES, "simple-ecs-service", "environments", "staging.tfvars"),
        "utf-8",
      );
      const vars = parseTfvars(content);

      assert.equal(vars.enable_app_service, "true");
      assert.equal(vars.app_service_desired_count, "1");
      assert.equal(vars.app_service_cpu, "256");
      assert.equal(vars.environment, "staging");
    });
  });
});

// ─── Service Matcher Tests ───

describe("Service Matcher", () => {
  describe("normaliseServiceName", () => {
    it("converts kebab-case to snake_case", () => {
      assert.equal(normaliseServiceName("query-service"), "query_service");
    });

    it("converts camelCase to snake_case", () => {
      assert.equal(normaliseServiceName("QueryService"), "query_service");
    });

    it("handles dots and spaces", () => {
      assert.equal(normaliseServiceName("my.app service"), "my_app_service");
    });

    it("collapses multiple separators", () => {
      assert.equal(normaliseServiceName("my--service__app"), "my_service_app");
    });
  });

  describe("matchServiceBlocks", () => {
    it("matches blocks by label prefix", async () => {
      const content = await readFile(join(FIXTURES, "simple-ecs-service", "app-service.tf"), "utf-8");
      const blocks = parseHclFile(content, "app-service.tf");
      const matched = matchServiceBlocks("app-service", blocks, {});

      // Should match app_service, app_service_worker, enable_app_service, and route53
      assert.ok(matched.length >= 2, `Expected at least 2 matched blocks, got ${matched.length}`);

      const labels = matched.map((b: any) => b.label);
      assert.ok(labels.includes("app_service"), "Should match app_service module");
    });

    it("isolates correct service in multi-service fixture", async () => {
      const files = ["billing.tf", "auth.tf", "notifications.tf"];
      const allBlocks: any[] = [];
      for (const f of files) {
        const content = await readFile(join(FIXTURES, "multi-service", f), "utf-8");
        allBlocks.push(...parseHclFile(content, f));
      }

      const matched = matchServiceBlocks("billing", allBlocks, { serviceName: "billing" });

      // Should only match billing-related blocks
      for (const block of matched) {
        const label = (block as any).label.toLowerCase();
        assert.ok(
          label.includes("billing") || label.includes("enable_billing"),
          `Unexpected match: ${label}`,
        );
      }
      assert.ok(matched.length >= 1, "Should find at least the billing module");
    });

    it("returns empty for non-existent service", async () => {
      const content = await readFile(join(FIXTURES, "simple-ecs-service", "app-service.tf"), "utf-8");
      const blocks = parseHclFile(content, "app-service.tf");
      const matched = matchServiceBlocks("nonexistent-service", blocks, {});

      assert.equal(matched.length, 0, "Should not match any blocks");
    });

    it("matches with serviceAliases", async () => {
      const files = ["billing.tf", "auth.tf", "notifications.tf"];
      const allBlocks: any[] = [];
      for (const f of files) {
        const content = await readFile(join(FIXTURES, "multi-service", f), "utf-8");
        allBlocks.push(...parseHclFile(content, f));
      }

      const matched = matchServiceBlocks("payment", allBlocks, {
        serviceName: "payment",
        serviceAliases: ["billing"],
      });

      assert.ok(matched.length >= 1, "Should match via alias");
    });
  });
});

// ─── Extractor Tests ───

describe("Extractor", () => {
  it("extracts env vars and secrets", async () => {
    const content = await readFile(join(FIXTURES, "simple-ecs-service", "app-service.tf"), "utf-8");
    const blocks = parseHclFile(content, "app-service.tf");
    const matched = matchServiceBlocks("app-service", blocks, { serviceName: "app-service" });

    const infra = extractServiceInfrastructure(matched, blocks, { serviceName: "app-service" });

    // Environment variables
    assert.ok(infra.envVars.length >= 5, `Expected at least 5 env vars, got ${infra.envVars.length}`);
    const svcName = infra.envVars.find((e: any) => e.name === "SERVICE_NAME");
    assert.ok(svcName, "Should find SERVICE_NAME");
    assert.equal(svcName.source, "literal");

    const envVar = infra.envVars.find((e: any) => e.name === "ENVIRONMENT");
    assert.ok(envVar, "Should find ENVIRONMENT");
    assert.equal(envVar.source, "variable");

    // Secrets
    assert.ok(infra.secrets.length >= 3, `Expected at least 3 secrets, got ${infra.secrets.length}`);
    const dbUrl = infra.secrets.find((s: any) => s.name === "DATABASE_URL");
    assert.ok(dbUrl, "Should find DATABASE_URL secret");
    assert.ok(dbUrl.arnPattern.includes("ssm"), "Should contain SSM ARN");
  });

  it("detects DNS and public-facing status", async () => {
    const content = await readFile(join(FIXTURES, "simple-ecs-service", "app-service.tf"), "utf-8");
    const blocks = parseHclFile(content, "app-service.tf");
    const matched = matchServiceBlocks("app-service", blocks, { serviceName: "app-service" });

    const infra = extractServiceInfrastructure(matched, blocks, { serviceName: "app-service" });

    assert.equal(infra.dns.isPublicFacing, true, "Should be public-facing");
    assert.ok(infra.dns.hostnames.length > 0, "Should have hostnames");
  });

  it("extracts components with deployment type", async () => {
    const content = await readFile(join(FIXTURES, "simple-ecs-service", "app-service.tf"), "utf-8");
    const blocks = parseHclFile(content, "app-service.tf");
    const matched = matchServiceBlocks("app-service", blocks, { serviceName: "app-service" });

    const infra = extractServiceInfrastructure(matched, blocks, { serviceName: "app-service" });

    assert.ok(infra.components.length >= 2, `Expected at least 2 components, got ${infra.components.length}`);

    const api = infra.components.find((c: any) => c.label === "app_service");
    assert.ok(api, "Should find app_service component");
    assert.equal(api.deploymentType, "ecs-fargate");
    assert.equal(api.compute?.cpu, "512");
    assert.equal(api.healthCheck, "/health");

    const worker = infra.components.find((c: any) => c.label === "app_service_worker");
    assert.ok(worker, "Should find app_service_worker component");
    assert.equal(worker.deploymentType, "ecs-worker");
  });

  it("extracts per-environment overrides from tfvars", async () => {
    const tfvarsFiles = [
      join(FIXTURES, "simple-ecs-service", "environments", "staging.tfvars"),
      join(FIXTURES, "simple-ecs-service", "environments", "production.tfvars"),
    ];

    const envs = await extractEnvironments(tfvarsFiles, "app-service");

    assert.ok(envs.staging, "Should have staging environment");
    assert.ok(envs.production, "Should have production environment");
    assert.equal(envs.staging.enabled, true);
    assert.equal(envs.staging.variables.app_service_cpu, "256");
    assert.equal(envs.production.variables.app_service_cpu, "1024");
    assert.equal(envs.production.variables.app_service_desired_count, "3");
  });
});

// ─── File Collector Tests ───

describe("File Collector", () => {
  it("discovers in-project terraform directory", async () => {
    const result = await collectTfFiles(join(FIXTURES, "in-project"), {});
    assert.ok(result.tfFiles.length > 0, "Should find .tf files in terraform/ subdir");
    assert.ok(
      result.tfFiles.some((f: string) => f.endsWith("main.tf")),
      "Should find main.tf",
    );
  });

  it("collects from explicit infraPath", async () => {
    const result = await collectTfFiles("/tmp", {
      infraPath: join(FIXTURES, "simple-ecs-service"),
    });
    assert.ok(result.tfFiles.length > 0, "Should find .tf files at explicit path");
    assert.ok(result.tfvarsFiles.length > 0, "Should find .tfvars files");
  });

  it("returns empty for non-existent path", async () => {
    const result = await collectTfFiles("/tmp/nonexistent-12345", {});
    assert.equal(result.tfFiles.length, 0);
    assert.equal(result.tfvarsFiles.length, 0);
  });
});

// ─── Formatter Tests ───

describe("Formatter", () => {
  it("generates markdown with all sections", async () => {
    const content = await readFile(join(FIXTURES, "simple-ecs-service", "app-service.tf"), "utf-8");
    const blocks = parseHclFile(content, "app-service.tf");
    const matched = matchServiceBlocks("app-service", blocks, { serviceName: "app-service" });
    const infra = extractServiceInfrastructure(matched, blocks, { serviceName: "app-service" });

    const tfvarsFiles = [
      join(FIXTURES, "simple-ecs-service", "environments", "staging.tfvars"),
      join(FIXTURES, "simple-ecs-service", "environments", "production.tfvars"),
    ];
    infra.environments = await extractEnvironments(tfvarsFiles, "app-service");

    const md = formatInfrastructure(infra);

    assert.ok(md.includes("# Infrastructure — app-service"), "Should have title");
    assert.ok(md.includes("## Components"), "Should have Components section");
    assert.ok(md.includes("## Environment Variables"), "Should have Env Vars section");
    assert.ok(md.includes("## Secrets"), "Should have Secrets section");
    assert.ok(md.includes("SERVICE_NAME"), "Should list SERVICE_NAME");
    assert.ok(md.includes("DATABASE_URL"), "Should list DATABASE_URL secret");
    assert.ok(md.includes("## Environments"), "Should have Environments section");
    assert.ok(md.includes("### staging"), "Should have staging env");
    assert.ok(md.includes("### production"), "Should have production env");
    assert.ok(md.includes("codesight-terraform-plugin"), "Should have attribution");
  });

  it("omits empty sections", () => {
    const md = formatInfrastructure({
      serviceName: "empty-service",
      sourceFiles: ["empty.tf"],
      components: [],
      dns: { hostnames: [], isPublicFacing: false },
      envVars: [],
      secrets: [],
      dependencies: [],
      iamPermissions: [],
      observability: { alarms: [] },
      environments: {},
    });

    assert.ok(md.includes("# Infrastructure — empty-service"), "Should have title");
    assert.ok(!md.includes("## Environment Variables"), "Should not have empty env vars section");
    assert.ok(!md.includes("## Secrets"), "Should not have empty secrets section");
    assert.ok(!md.includes("## Dependencies"), "Should not have empty deps section");
  });
});

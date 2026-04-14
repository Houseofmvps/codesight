import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

async function writeFixture(subdir: string, files: Record<string, string>) {
  const dir = join(FIXTURE_ROOT, subdir);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  return dir;
}

// =================== YAML PARSER TESTS ===================

describe("YAML Parser", async () => {
  const { parseYAML } = await import("../../dist/plugins/cicd/yaml-parser.js");

  it("parses block mappings", () => {
    const result = parseYAML("name: test\nversion: 2.1");
    assert.equal(result.name, "test");
  });

  it("parses block sequences of scalars", () => {
    const result = parseYAML("items:\n  - a\n  - b\n  - c");
    assert.deepEqual(result.items, ["a", "b", "c"]);
  });

  it("parses array-of-objects (steps pattern)", () => {
    const yaml = [
      "steps:",
      "  - name: Checkout",
      "    uses: actions/checkout@v4",
      "  - name: Setup",
      "    uses: actions/setup-node@v4",
    ].join("\n");
    const result = parseYAML(yaml);
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0].name, "Checkout");
    assert.equal(result.steps[0].uses, "actions/checkout@v4");
    assert.equal(result.steps[1].name, "Setup");
  });

  it("parses block scalars (|)", () => {
    const yaml = [
      "script: |",
      "  echo hello",
      "  echo world",
      "other: val",
    ].join("\n");
    const result = parseYAML(yaml);
    assert.ok(result.script.includes("echo hello"));
    assert.ok(result.script.includes("echo world"));
    assert.equal(result.other, "val");
  });

  it("parses flow sequences", () => {
    const result = parseYAML("needs: [build, test, lint]");
    assert.deepEqual(result.needs, ["build", "test", "lint"]);
  });

  it("handles inline comments", () => {
    const result = parseYAML("key: value # this is a comment");
    assert.equal(result.key, "value");
  });

  it("handles quoted strings with colons", () => {
    const result = parseYAML('name: "Deploy: staging"');
    assert.equal(result.name, "Deploy: staging");
  });

  it("handles empty mapping values with nested content", () => {
    const yaml = [
      "on:",
      "  push:",
      "    branches:",
      "      - main",
    ].join("\n");
    const result = parseYAML(yaml);
    assert.deepEqual(result.on.push.branches, ["main"]);
  });

  it("handles mixed scalar and mapping dash items", () => {
    const yaml = [
      "jobs:",
      "  - test",
      "  - deploy:",
      "      requires:",
      "        - test",
    ].join("\n");
    const result = parseYAML(yaml);
    assert.equal(result.jobs[0], "test");
    assert.ok(typeof result.jobs[1] === "object");
    assert.deepEqual(result.jobs[1].deploy.requires, ["test"]);
  });

  it("preserves expressions as opaque strings", () => {
    const result = parseYAML("ref: ${{ inputs.ref }}");
    assert.equal(result.ref, "${{ inputs.ref }}");
  });

  it("handles document marker ---", () => {
    const yaml = "---\nname: test\nversion: 1";
    const result = parseYAML(yaml);
    assert.equal(result.name, "test");
  });

  it("parses single-quoted strings", () => {
    const result = parseYAML("version: '3.12'");
    assert.equal(result.version, "3.12");
  });

  it("parses boolean values", () => {
    const result = parseYAML("required: true\noptional: false");
    assert.equal(result.required, true);
    assert.equal(result.optional, false);
  });

  it("handles real-world GHA workflow structure", () => {
    const yaml = [
      "name: CI",
      "on:",
      "  push:",
      "    branches: [main]",
      "  pull_request:",
      "    branches: [main]",
      "    paths:",
      "      - 'src/**'",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - name: Install",
      "        run: npm ci",
      "      - name: Test",
      "        run: npm test",
    ].join("\n");
    const result = parseYAML(yaml);
    assert.equal(result.name, "CI");
    assert.deepEqual(result.on.push.branches, ["main"]);
    assert.deepEqual(result.on.pull_request.paths, ["src/**"]);
    assert.equal(result.jobs.build["runs-on"], "ubuntu-latest");
    assert.equal(result.jobs.build.steps.length, 3);
    assert.equal(result.jobs.build.steps[0].uses, "actions/checkout@v4");
  });

  it("handles flow sequence as runner", () => {
    const yaml = "runs-on: [self-hosted, staging-deploy]";
    const result = parseYAML(yaml);
    assert.deepEqual(result["runs-on"], ["self-hosted", "staging-deploy"]);
  });
});

// =================== GITHUB ACTIONS TESTS ===================

describe("GitHub Actions Detection", async () => {
  const { parseYAML } = await import("../../dist/plugins/cicd/yaml-parser.js");
  const { extractGitHubActionsWorkflow } = await import("../../dist/plugins/cicd/github-actions.js");

  it("extracts basic workflow", () => {
    const yaml = [
      "name: CI",
      "on: [push, pull_request]",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: npm test",
    ].join("\n");
    const parsed = parseYAML(yaml);
    const pipeline = extractGitHubActionsWorkflow(parsed, ".github/workflows/ci.yml", yaml);

    assert.ok(pipeline);
    assert.equal(pipeline.name, "CI");
    assert.equal(pipeline.system, "github-actions");
    assert.ok(pipeline.triggers.some(t => t.event === "push"));
    assert.ok(pipeline.triggers.some(t => t.event === "pull_request"));
    assert.equal(pipeline.jobs.length, 1);
    assert.equal(pipeline.jobs[0].name, "test");
    assert.equal(pipeline.jobs[0].runner, "ubuntu-latest");
    assert.ok(pipeline.jobs[0].actions?.includes("actions/checkout@v4"));
  });

  it("detects reusable workflows", () => {
    const yaml = [
      "name: Deploy",
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      ref:",
      "        type: string",
      "jobs:",
      "  staging:",
      "    uses: ./.github/workflows/_shared-deploy.yml",
      "    with:",
      "      environment: staging",
      "  production:",
      "    needs: staging",
      "    uses: ./.github/workflows/_shared-deploy.yml",
      "    with:",
      "      environment: production",
    ].join("\n");
    const parsed = parseYAML(yaml);
    const pipeline = extractGitHubActionsWorkflow(parsed, ".github/workflows/deploy.yml", yaml);

    assert.ok(pipeline);
    assert.ok(pipeline.reusableWorkflows?.includes("./.github/workflows/_shared-deploy.yml"));
    assert.equal(pipeline.jobs.length, 2);
    assert.ok(pipeline.jobs[1].needs?.includes("staging"));
  });

  it("detects workflow_call as reusable", () => {
    const yaml = [
      "name: Shared Deploy",
      "on:",
      "  workflow_call:",
      "    inputs:",
      "      environment:",
      "        type: string",
      "jobs:",
      "  deploy:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
    ].join("\n");
    const parsed = parseYAML(yaml);
    const pipeline = extractGitHubActionsWorkflow(parsed, ".github/workflows/_shared-deploy.yml", yaml);

    assert.ok(pipeline);
    assert.equal(pipeline.isReusable, true);
  });

  it("extracts secrets from expressions", () => {
    const yaml = [
      "name: CI",
      "on: [push]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo ${{ secrets.AWS_ACCESS_KEY_ID }}",
      "      - run: echo ${{ secrets.DEPLOY_TOKEN }}",
    ].join("\n");
    const parsed = parseYAML(yaml);
    const pipeline = extractGitHubActionsWorkflow(parsed, ".github/workflows/ci.yml", yaml);

    assert.ok(pipeline);
    assert.ok(pipeline.secrets?.includes("AWS_ACCESS_KEY_ID"));
    assert.ok(pipeline.secrets?.includes("DEPLOY_TOKEN"));
  });

  it("infers ECS deploy target", () => {
    const yaml = [
      "name: Deploy",
      "on: [push]",
      "jobs:",
      "  deploy:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: aws-actions/amazon-ecs-deploy-task-definition@v1",
    ].join("\n");
    const parsed = parseYAML(yaml);
    const pipeline = extractGitHubActionsWorkflow(parsed, ".github/workflows/deploy.yml", yaml);

    assert.ok(pipeline);
    assert.equal(pipeline.jobs[0].deployTarget, "ecs");
  });

  it("extracts workflow-level env vars", () => {
    const yaml = [
      "name: CI",
      "on: [push]",
      "env:",
      "  AWS_REGION: eu-central-1",
      "  NODE_ENV: test",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo test",
    ].join("\n");
    const parsed = parseYAML(yaml);
    const pipeline = extractGitHubActionsWorkflow(parsed, ".github/workflows/ci.yml", yaml);

    assert.ok(pipeline);
    assert.ok(pipeline.envVars?.includes("AWS_REGION"));
    assert.ok(pipeline.envVars?.includes("NODE_ENV"));
  });
});

// =================== CIRCLECI TESTS ===================

describe("CircleCI Detection", async () => {
  const { parseYAML } = await import("../../dist/plugins/cicd/yaml-parser.js");
  const { extractCircleCIWorkflows } = await import("../../dist/plugins/cicd/circleci.js");

  it("extracts basic workflow", () => {
    const yaml = [
      "version: 2.1",
      "jobs:",
      "  test:",
      "    docker:",
      "      - image: cimg/node:18.0",
      "    steps:",
      "      - checkout",
      "      - run: npm test",
      "  deploy:",
      "    docker:",
      "      - image: cimg/node:18.0",
      "    steps:",
      "      - checkout",
      "      - run: npm run deploy",
      "workflows:",
      "  build-and-deploy:",
      "    jobs:",
      "      - test",
      "      - deploy:",
      "          requires:",
      "            - test",
      "          context:",
      "            - production",
    ].join("\n");
    const parsed = parseYAML(yaml);
    const pipelines = extractCircleCIWorkflows(parsed, ".circleci/config.yml", yaml);

    assert.equal(pipelines.length, 1);
    const wf = pipelines[0];
    assert.equal(wf.name, "build-and-deploy");
    assert.equal(wf.system, "circleci");
    assert.equal(wf.jobs.length, 2);
    assert.ok(wf.jobs.some(j => j.name === "test"));
    assert.ok(wf.jobs.some(j => j.name === "deploy" && j.needs?.includes("test")));
    assert.ok(wf.environments?.includes("production"));
  });

  it("detects orbs as env vars", () => {
    const yaml = [
      "version: 2.1",
      "orbs:",
      "  aws-cli: circleci/aws-cli@5.1",
      "  python: circleci/python@2",
      "jobs:",
      "  test:",
      "    docker:",
      "      - image: cimg/python:3.14",
      "    steps:",
      "      - checkout",
      "workflows:",
      "  ci:",
      "    jobs:",
      "      - test",
    ].join("\n");
    const parsed = parseYAML(yaml);
    const pipelines = extractCircleCIWorkflows(parsed, ".circleci/config.yml", yaml);

    assert.ok(pipelines[0].envVars?.includes("orb:aws-cli"));
    assert.ok(pipelines[0].envVars?.includes("orb:python"));
  });

  it("extracts docker image as runner", () => {
    const yaml = [
      "version: 2.1",
      "jobs:",
      "  test:",
      "    docker:",
      "      - image: cimg/python:3.14",
      "    steps:",
      "      - checkout",
      "workflows:",
      "  ci:",
      "    jobs:",
      "      - test",
    ].join("\n");
    const parsed = parseYAML(yaml);
    const pipelines = extractCircleCIWorkflows(parsed, ".circleci/config.yml", yaml);

    assert.equal(pipelines[0].jobs[0].runner, "cimg/python:3.14");
  });
});

// =================== PLUGIN INTEGRATION TESTS ===================

describe("CI/CD Plugin Integration", async () => {
  const { collectFiles, detectProject } = await import("../../dist/scanner.js");
  const { createCICDPlugin } = await import("../../dist/plugins/cicd/index.js");

  it("produces customSection for GitHub Actions project", async () => {
    const dir = await writeFixture("cicd-github-actions", {
      "package.json": JSON.stringify({ name: "test-gha" }),
      ".github/workflows/ci.yml": [
        "name: CI",
        "on:",
        "  push:",
        "    branches: [main]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: npm test",
      ].join("\n"),
    });
    const project = await detectProject(dir);
    const files = await collectFiles(dir);
    const plugin = createCICDPlugin();
    const result = await plugin.detector!(files, project);

    assert.ok(result.customSections);
    assert.equal(result.customSections.length, 1);
    assert.equal(result.customSections[0].name, "cicd");
    assert.ok(result.customSections[0].content.includes("CI"));
    assert.ok(result.customSections[0].content.includes("GitHub Actions"));
  });

  it("produces customSection for CircleCI project", async () => {
    const dir = await writeFixture("cicd-circleci", {
      "package.json": JSON.stringify({ name: "test-cci" }),
      ".circleci/config.yml": [
        "version: 2.1",
        "jobs:",
        "  test:",
        "    docker:",
        "      - image: cimg/node:18.0",
        "    steps:",
        "      - checkout",
        "workflows:",
        "  ci:",
        "    jobs:",
        "      - test",
      ].join("\n"),
    });
    const project = await detectProject(dir);
    const files = await collectFiles(dir);
    const plugin = createCICDPlugin();
    const result = await plugin.detector!(files, project);

    assert.ok(result.customSections);
    assert.equal(result.customSections[0].name, "cicd");
    assert.ok(result.customSections[0].content.includes("CircleCI"));
  });

  it("returns empty for projects without CI/CD", async () => {
    const dir = await writeFixture("cicd-none", {
      "package.json": JSON.stringify({ name: "test-none" }),
      "src/index.ts": "console.log('hello');",
    });
    const project = await detectProject(dir);
    const files = await collectFiles(dir);
    const plugin = createCICDPlugin();
    const result = await plugin.detector!(files, project);

    assert.equal(result.customSections, undefined);
  });

  it("respects systems filter", async () => {
    const dir = await writeFixture("cicd-filter", {
      "package.json": JSON.stringify({ name: "test-filter" }),
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo test",
      ].join("\n"),
      ".circleci/config.yml": [
        "version: 2.1",
        "jobs:",
        "  test:",
        "    docker:",
        "      - image: node:18",
        "    steps:",
        "      - checkout",
        "workflows:",
        "  ci:",
        "    jobs:",
        "      - test",
      ].join("\n"),
    });
    const project = await detectProject(dir);
    const files = await collectFiles(dir);

    // Only GitHub Actions
    const ghPlugin = createCICDPlugin({ systems: ["github-actions"] });
    const ghResult = await ghPlugin.detector!(files, project);
    assert.ok(ghResult.customSections?.[0].content.includes("GitHub Actions"));
    assert.ok(!ghResult.customSections?.[0].content.includes("CircleCI"));
  });
});

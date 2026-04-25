import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function setup(files: Record<string, string>, executablePaths: string[] = []): Promise<string> {
  const root = join(tmpdir(), `codesight-githooks-test-${Date.now()}`);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  for (const rel of executablePaths) {
    await chmod(join(root, rel), 0o755);
  }
  return root;
}

async function cleanup(root: string) {
  await rm(root, { recursive: true, force: true });
}

const fakeProject = (root: string) => ({ root, frameworks: [], language: "typescript", orms: [], isMonorepo: false, workspaces: [], repoType: "single" as const });

describe("Git Hooks Plugin", async () => {
  const { createGitHooksPlugin } = await import("../dist/plugins/githooks/index.js");

  it("parses lefthook.yml with commands block", async () => {
    const root = await setup({
      "lefthook.yml": `pre-commit:\n  commands:\n    lint:\n      run: pnpm lint\n    typecheck:\n      run: pnpm typecheck\npre-push:\n  commands:\n    test:\n      run: pnpm test\n`,
    });
    try {
      const plugin = createGitHooksPlugin();
      const result = await plugin.detector!([], fakeProject(root));
      assert.ok(result.customSections?.length === 1);
      const content = result.customSections![0].content;
      assert.ok(content.includes("pre-commit"), "should include pre-commit");
      assert.ok(content.includes("pnpm lint"), "should include lint command");
      assert.ok(content.includes("pnpm typecheck"), "should include typecheck command");
      assert.ok(content.includes("pre-push"), "should include pre-push");
      assert.ok(content.includes("pnpm test"), "should include test command");
    } finally {
      await cleanup(root);
    }
  });

  it("parses lefthook.json", async () => {
    const root = await setup({
      "lefthook.json": JSON.stringify({
        "pre-commit": { commands: { lint: { run: "pnpm lint" } } },
      }),
    });
    try {
      const plugin = createGitHooksPlugin();
      const result = await plugin.detector!([], fakeProject(root));
      const content = result.customSections![0].content;
      assert.ok(content.includes("pnpm lint"));
    } finally {
      await cleanup(root);
    }
  });

  it("parses husky hooks", async () => {
    const root = await setup({
      ".husky/pre-commit": `#!/bin/sh\npnpm lint\npnpm typecheck\n`,
    });
    try {
      const plugin = createGitHooksPlugin();
      const result = await plugin.detector!([], fakeProject(root));
      const content = result.customSections![0].content;
      assert.ok(content.includes("pre-commit"));
      assert.ok(content.includes("pnpm lint"));
      assert.ok(content.includes("husky"));
    } finally {
      await cleanup(root);
    }
  });

  it("parses raw executable git hooks", async () => {
    const root = await setup(
      { ".git/hooks/pre-commit": `#!/bin/sh\nnpm test\n` },
      [".git/hooks/pre-commit"],
    );
    try {
      const plugin = createGitHooksPlugin();
      const result = await plugin.detector!([], fakeProject(root));
      const content = result.customSections![0].content;
      assert.ok(content.includes("pre-commit"));
      assert.ok(content.includes("npm test"));
    } finally {
      await cleanup(root);
    }
  });

  it("suppresses raw hook when lefthook manages the same lifecycle", async () => {
    const root = await setup(
      {
        "lefthook.yml": `pre-commit:\n  commands:\n    lint:\n      run: pnpm lint\n`,
        // Simulates lefthook-installed raw hook
        ".git/hooks/pre-commit": `#!/bin/sh\nlefthook run pre-commit\n`,
      },
      [".git/hooks/pre-commit"],
    );
    try {
      const plugin = createGitHooksPlugin();
      const result = await plugin.detector!([], fakeProject(root));
      const content = result.customSections![0].content;
      assert.ok(content.includes("lefthook"), "should show lefthook section");
      const rawOccurrences = (content.match(/raw git hook/g) || []).length;
      assert.equal(rawOccurrences, 0, "should suppress raw hook when lefthook manages the lifecycle");
    } finally {
      await cleanup(root);
    }
  });

  it("ignores .sample files in .git/hooks", async () => {
    const root = await setup(
      { ".git/hooks/pre-commit.sample": `#!/bin/sh\nnpm test\n` },
      [".git/hooks/pre-commit.sample"],
    );
    try {
      const plugin = createGitHooksPlugin();
      const result = await plugin.detector!([], fakeProject(root));
      assert.deepEqual(result, {});
    } finally {
      await cleanup(root);
    }
  });

  it("returns empty when no hooks found", async () => {
    const root = await setup({ "package.json": `{"name":"test"}` });
    try {
      const plugin = createGitHooksPlugin();
      const result = await plugin.detector!([], fakeProject(root));
      assert.deepEqual(result, {});
    } finally {
      await cleanup(root);
    }
  });

  it("output includes agent warning note", async () => {
    const root = await setup({
      "lefthook.yml": `pre-commit:\n  commands:\n    lint:\n      run: pnpm lint\n`,
    });
    try {
      const plugin = createGitHooksPlugin();
      const result = await plugin.detector!([], fakeProject(root));
      const content = result.customSections![0].content;
      assert.ok(content.includes("agents"), "should include note for agents");
    } finally {
      await cleanup(root);
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function setup(files: Record<string, string>): Promise<string> {
  const root = join(tmpdir(), `codesight-skills-test-${Date.now()}`);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

async function cleanup(root: string) {
  await rm(root, { recursive: true, force: true });
}

const fakeProject = (root: string) => ({ root, frameworks: [], language: "typescript", orms: [], isMonorepo: false, workspaces: [], repoType: "single" as const });

describe("Skills Plugin", async () => {
  const { createSkillsPlugin } = await import("../dist/plugins/skills/index.js");

  it("detects skills in .claude/commands", async () => {
    const root = await setup({
      ".claude/commands/review.md": `---\ndescription: Pre-landing PR review\n---\nReview the current PR.`,
      ".claude/commands/ship.md": `---\ndescription: Ship workflow\n---\nMerge and deploy.`,
    });
    try {
      const plugin = createSkillsPlugin();
      const result = await plugin.detector!([], fakeProject(root));
      assert.ok(result.customSections?.length === 1);
      const content = result.customSections![0].content;
      assert.ok(content.includes("/review"), "should include /review");
      assert.ok(content.includes("Pre-landing PR review"), "should include description");
      assert.ok(content.includes("/ship"), "should include /ship");
    } finally {
      await cleanup(root);
    }
  });

  it("detects skills in .claude/skills", async () => {
    const root = await setup({
      ".claude/skills/investigate.md": `---\ndescription: Systematic debugging\n---\nInvestigate the issue.`,
    });
    try {
      const plugin = createSkillsPlugin();
      const result = await plugin.detector!([], fakeProject(root));
      assert.ok(result.customSections?.length === 1);
      assert.ok(result.customSections![0].content.includes("/investigate"));
    } finally {
      await cleanup(root);
    }
  });

  it("falls back to first line when no frontmatter description", async () => {
    const root = await setup({
      ".claude/commands/health.md": `# Health check\n\nRuns the health dashboard.`,
    });
    try {
      const plugin = createSkillsPlugin();
      const result = await plugin.detector!([], fakeProject(root));
      const content = result.customSections![0].content;
      assert.ok(content.includes("Health check"), "should fall back to heading text");
    } finally {
      await cleanup(root);
    }
  });

  it("returns empty when no skill directories exist", async () => {
    const root = await setup({ "src/index.ts": "export {}" });
    try {
      const plugin = createSkillsPlugin();
      const result = await plugin.detector!([], fakeProject(root));
      assert.deepEqual(result, {});
    } finally {
      await cleanup(root);
    }
  });

  it("merges skills from both directories", async () => {
    const root = await setup({
      ".claude/commands/review.md": `---\ndescription: Review\n---`,
      ".claude/skills/investigate.md": `---\ndescription: Investigate\n---`,
    });
    try {
      const plugin = createSkillsPlugin();
      const result = await plugin.detector!([], fakeProject(root));
      const content = result.customSections![0].content;
      assert.ok(content.includes("/review"));
      assert.ok(content.includes("/investigate"));
    } finally {
      await cleanup(root);
    }
  });
});

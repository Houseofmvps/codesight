import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitHook } from "./types.js";

const HOOK_NAMES = new Set([
  "pre-commit", "commit-msg", "prepare-commit-msg", "post-commit",
  "pre-push", "post-merge", "post-checkout", "pre-rebase", "post-rewrite",
]);

export async function parseHusky(root: string): Promise<GitHook[]> {
  const hooks: GitHook[] = [];
  try {
    const entries = await readdir(join(root, ".husky"), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !HOOK_NAMES.has(entry.name)) continue;
      const content = await readFile(join(root, ".husky", entry.name), "utf-8");
      const commands = extractShellCommands(content);
      if (commands.length > 0) {
        hooks.push({ lifecycle: entry.name, tool: "husky", commands, source: `.husky/${entry.name}` });
      }
    }
  } catch {
    // .husky dir doesn't exist
  }
  return hooks;
}

function extractShellCommands(content: string) {
  return content
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#") && !/^#!/.test(l) && !l.startsWith(". "))
    .map(run => ({ name: run.split(/\s+/)[0], run }));
}

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitHook } from "./types.js";

const HOOK_NAMES = new Set([
  "pre-commit", "commit-msg", "prepare-commit-msg", "post-commit",
  "pre-push", "post-merge", "post-checkout", "pre-rebase", "post-rewrite",
]);

export async function parseRawHooks(root: string): Promise<GitHook[]> {
  const hooks: GitHook[] = [];
  const hooksDir = join(root, ".git", "hooks");
  try {
    const entries = await readdir(hooksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith(".sample") || !HOOK_NAMES.has(entry.name)) continue;
      const fullPath = join(hooksDir, entry.name);
      // Skip non-executable files
      const s = await stat(fullPath).catch(() => null);
      if (!s || !(s.mode & 0o111)) continue;
      const content = await readFile(fullPath, "utf-8").catch(() => "");
      const commands = extractShellCommands(content);
      if (commands.length > 0) {
        hooks.push({ lifecycle: entry.name, tool: "raw", commands, source: `.git/hooks/${entry.name}` });
      }
    }
  } catch {
    // .git/hooks doesn't exist
  }
  return hooks;
}

function extractShellCommands(content: string) {
  return content
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#") && !/^#!/.test(l))
    .map(run => ({ name: run.split(/\s+/)[0], run }));
}

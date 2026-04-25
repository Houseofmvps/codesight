import type { GitHook } from "./types.js";

const LIFECYCLE_ORDER = [
  "pre-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push", "post-rewrite",
];

const TOOL_LABEL: Record<string, string> = {
  lefthook: "lefthook",
  husky: "husky",
  raw: "raw git hook",
};

export function formatGitHooks(hooks: GitHook[]): string {
  const lines: string[] = [];
  lines.push("# Git Hooks", "");
  lines.push("> **Note for agents:** These hooks fire automatically on git operations and will block the operation if they fail.", "");

  const sorted = [...hooks].sort((a, b) => {
    const ai = LIFECYCLE_ORDER.indexOf(a.lifecycle);
    const bi = LIFECYCLE_ORDER.indexOf(b.lifecycle);
    if (ai === -1 && bi === -1) return a.lifecycle.localeCompare(b.lifecycle);
    return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
  });

  for (const hook of sorted) {
    lines.push(`## \`${hook.lifecycle}\` — ${TOOL_LABEL[hook.tool] ?? hook.tool}`, "");
    for (const cmd of hook.commands) {
      lines.push(`- **${cmd.name}**: \`${cmd.run}\``);
    }
    lines.push("");
  }

  const sources = [...new Set(hooks.map(h => h.source))].sort();
  lines.push(`_Source: ${sources.join(", ")}_`, "");

  return lines.join("\n");
}

import type { Skill } from "./index.js";

export function formatSkills(skills: Skill[]): string {
  const lines: string[] = [];
  lines.push("# Claude Skills", "");
  lines.push("Project-local slash commands available to Claude Code agents:", "");

  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    const desc = skill.description ? ` — ${skill.description}` : "";
    lines.push(`- \`/${skill.name}\`${desc}`);
  }

  const dirs = [...new Set(skills.map(s => s.path.split("/").slice(0, -1).join("/")))].sort();
  lines.push("", `_Source: ${dirs.join(", ")}_`, "");

  return lines.join("\n");
}

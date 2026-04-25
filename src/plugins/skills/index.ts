import { readdir, readFile } from "node:fs/promises";
import { join, basename, extname, relative } from "node:path";
import type { CodesightPlugin, ProjectInfo } from "../../types.js";
import { formatSkills } from "./formatter.js";

export interface Skill {
  name: string;
  description: string;
  path: string;
}

const SKILL_DIRS = [".claude/commands", ".claude/skills"];

export function createSkillsPlugin(): CodesightPlugin {
  return {
    name: "skills",
    detector: async (_files: string[], project: ProjectInfo) => {
      const skills: Skill[] = [];

      for (const dir of SKILL_DIRS) {
        const found = await readSkillsDir(join(project.root, dir), project.root);
        skills.push(...found);
      }

      if (skills.length === 0) return {};

      return {
        customSections: [{ name: "skills", content: formatSkills(skills) }],
      };
    },
  };
}

async function readSkillsDir(dir: string, root: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(md|txt)$/.test(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      const content = await readFile(fullPath, "utf-8");
      skills.push({
        name: basename(entry.name, extname(entry.name)),
        description: extractDescription(content),
        path: relative(root, fullPath).replace(/\\/g, "/"),
      });
    }
  } catch {
    // dir doesn't exist — not an error
  }
  return skills;
}

function extractDescription(content: string): string {
  // Prefer frontmatter description: field
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
    if (descMatch) return descMatch[1].trim();
  }

  // Fall back to first non-empty line after stripping frontmatter and headings
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;
  for (const line of body.split("\n")) {
    const trimmed = line.trim().replace(/^#+\s*/, "");
    if (trimmed) return trimmed;
  }

  return "";
}

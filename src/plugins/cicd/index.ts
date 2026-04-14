import { readFile, readdir } from "node:fs/promises";
import { relative, join } from "node:path";
import type { CodesightPlugin, ProjectInfo } from "../../types.js";
import type { CICDPipeline } from "./types.js";
import { parseYAML } from "./yaml-parser.js";
import { extractGitHubActionsWorkflow } from "./github-actions.js";
import { extractCircleCIWorkflows } from "./circleci.js";
import { formatCICD } from "./formatter.js";

export type { CICDPipeline, CICDTrigger, CICDJob, CICDSystem } from "./types.js";

export interface CICDPluginConfig {
  /** CI systems to scan. Default: all supported systems. */
  systems?: ("github-actions" | "circleci")[];
}

/**
 * Create a CI/CD pipeline detection plugin for codesight.
 *
 * Scans GitHub Actions workflow files and CircleCI config files,
 * extracts pipeline structure (triggers, jobs, secrets, deploy targets),
 * and produces a cicd.md section.
 *
 * CI/CD configs live in dotfile directories (.github/, .circleci/) which
 * codesight's collectFiles() skips. This plugin discovers them independently
 * from project.root, similar to how the Terraform plugin discovers .tf files.
 *
 * @example
 * // Detect all supported CI systems
 * createCICDPlugin()
 *
 * @example
 * // Only scan GitHub Actions
 * createCICDPlugin({ systems: ["github-actions"] })
 */
export function createCICDPlugin(config: CICDPluginConfig = {}): CodesightPlugin {
  const systems = new Set(config.systems || ["github-actions", "circleci"]);

  return {
    name: "cicd",

    detector: async (_files: string[], project: ProjectInfo) => {
      const pipelines: CICDPipeline[] = [];

      // GitHub Actions — discover from .github/workflows/ directly
      if (systems.has("github-actions")) {
        const ghFiles = await collectGitHubActionsFiles(project.root);
        for (const file of ghFiles) {
          const content = await readFileSafe(file);
          if (!content) continue;
          try {
            const parsed = parseYAML(content);
            const relPath = relative(project.root, file).replace(/\\/g, "/");
            const pipeline = extractGitHubActionsWorkflow(parsed, relPath, content);
            if (pipeline) pipelines.push(pipeline);
          } catch {
            // Skip unparseable files
          }
        }
      }

      // CircleCI — discover from .circleci/ directly
      if (systems.has("circleci")) {
        const circleFile = join(project.root, ".circleci", "config.yml");
        const content = await readFileSafe(circleFile);
        if (content) {
          try {
            const parsed = parseYAML(content);
            const relPath = relative(project.root, circleFile).replace(/\\/g, "/");
            const extracted = extractCircleCIWorkflows(parsed, relPath, content);
            pipelines.push(...extracted);
          } catch {
            // Skip unparseable files
          }
        }
      }

      if (pipelines.length === 0) return {};

      return {
        customSections: [{ name: "cicd", content: formatCICD(pipelines) }],
      };
    },
  };
}

/** Collect .yml/.yaml files from .github/workflows/ */
async function collectGitHubActionsFiles(root: string): Promise<string[]> {
  const workflowsDir = join(root, ".github", "workflows");
  try {
    const entries = await readdir(workflowsDir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && /\.ya?ml$/.test(e.name))
      .map(e => join(workflowsDir, e.name));
  } catch {
    return [];
  }
}

async function readFileSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

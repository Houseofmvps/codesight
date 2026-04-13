import { relative } from "node:path";
import type { CodesightPlugin, ProjectInfo } from "../../types.js";
import type { TerraformPluginConfig, HclBlock } from "./types.js";
import { parseHclFile } from "./hcl-parser.js";
import { collectTfFiles, readFileSafe } from "./file-collector.js";
import { matchServiceBlocks } from "./service-matcher.js";
import { extractServiceInfrastructure, extractEnvironments } from "./extractor.js";
import { formatInfrastructure } from "./formatter.js";

export type { TerraformPluginConfig } from "./types.js";

/**
 * Create a Terraform infrastructure plugin for codesight.
 *
 * Scans .tf files — either co-located in the project or in a separate
 * infrastructure repo — and generates an infrastructure section with
 * deployment context for AI agents.
 *
 * @example
 * // Auto-discover infrastructure
 * createTerraformPlugin()
 *
 * @example
 * // Explicit centralised infra repo
 * createTerraformPlugin({
 *   infraPath: '../infrastructure',
 *   serviceName: 'query-service',
 * })
 */
export function createTerraformPlugin(config: TerraformPluginConfig = {}): CodesightPlugin {
  return {
    name: "terraform",

    detector: async (files: string[], project: ProjectInfo) => {
      const serviceName = config.serviceName ?? project.name;

      // Collect .tf files from project or external path
      const collected = await collectTfFiles(project.root, config);
      if (collected.tfFiles.length === 0) return {};

      // Parse all .tf files into HCL blocks
      // TODO: consider Promise.all for parallel file reads in large infra repos
      const allBlocks: HclBlock[] = [];
      for (const tfFile of collected.tfFiles) {
        const content = await readFileSafe(tfFile);
        if (!content) continue;
        const relPath = relative(collected.basePath, tfFile);
        const blocks = parseHclFile(content, relPath);
        allBlocks.push(...blocks);
      }

      if (allBlocks.length === 0) return {};

      // Match blocks to this service
      const matched = matchServiceBlocks(
        serviceName,
        allBlocks,
        { ...config, serviceName },
      );
      if (matched.length === 0) return {};

      // Extract structured infrastructure data
      const infra = extractServiceInfrastructure(
        matched,
        allBlocks,
        { ...config, serviceName },
      );

      // Extract per-environment overrides from .tfvars
      if (config.scanEnvironments !== false && collected.tfvarsFiles.length > 0) {
        infra.environments = await extractEnvironments(
          collected.tfvarsFiles,
          serviceName,
        );
      }

      return {
        customSections: [{ name: "infrastructure", content: formatInfrastructure(infra) }],
      };
    },
  };
}

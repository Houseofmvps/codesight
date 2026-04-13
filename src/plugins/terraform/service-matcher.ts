import { basename } from "node:path";
import type { HclBlock, TerraformPluginConfig } from "./types.js";

export interface ScoredBlock {
  block: HclBlock;
  score: number;
}

/**
 * Find all HCL blocks belonging to a given service.
 * Uses a multi-signal scoring algorithm: file name, label prefix/exact,
 * image URI, enable flags, and user-configured aliases.
 */
export function matchServiceBlocks(
  projectName: string,
  blocks: HclBlock[],
  config: TerraformPluginConfig,
): HclBlock[] {
  const serviceName = config.serviceName ?? projectName;
  const normalised = normaliseServiceName(serviceName);

  if (!normalised) return [];

  const scored: ScoredBlock[] = [];

  for (const block of blocks) {
    const score = scoreBlock(normalised, block, config);
    if (score >= 2) {
      scored.push({ block, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.block);
}

function scoreBlock(
  normalisedService: string,
  block: HclBlock,
  config: TerraformPluginConfig,
): number {
  let score = 0;
  const normalisedLabel = normaliseServiceName(block.label);

  // File name contains service name (+2)
  const fileName = normaliseServiceName(basename(block.file, ".tf").replace(".variables", ""));
  if (fileName && fileName.includes(normalisedService)) {
    score += 2;
  }

  // Block label starts with service name (+3)
  if (normalisedLabel.startsWith(normalisedService)) {
    score += 3;
  }

  // Block label exact match (+5, replaces prefix)
  if (normalisedLabel === normalisedService) {
    score += 2; // +5 total with prefix
  }

  // Image URI contains service name (+4)
  const imageAttr = block.attributes["image"] ?? block.attributes["container_image"];
  if (imageAttr) {
    const kebabName = normalisedService.replace(/_/g, "-");
    if (imageAttr.includes(kebabName) || imageAttr.includes(normalisedService)) {
      score += 4;
    }
  }

  // Enable flag match (+3)
  if (block.blockType === "variable") {
    const enablePrefix = `enable_${normalisedService}`;
    if (normalisedLabel === enablePrefix || normalisedLabel.startsWith(enablePrefix)) {
      score += 3;
    }
  }

  // count = var.enable_xxx pattern in non-variable blocks (+2)
  const countAttr = block.attributes["count"];
  if (countAttr) {
    const enableRef = `var.enable_${normalisedService}`;
    if (countAttr.includes(enableRef)) {
      score += 2;
    }
  }

  // Service aliases match (+2)
  for (const alias of config.serviceAliases ?? []) {
    const normalisedAlias = normaliseServiceName(alias);
    if (normalisedAlias && normalisedLabel.includes(normalisedAlias)) {
      score += 2;
    }
  }

  return score;
}

/**
 * Normalise a service name for comparison.
 * "query-service" → "query_service"
 * "QueryService" → "query_service"
 * "query-service-app" → "query_service_app"
 */
export function normaliseServiceName(name: string): string {
  return name
    // Insert underscore before uppercase letters (camelCase → camel_Case)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    // Replace hyphens, dots, spaces with underscores
    .replace(/[^a-z0-9]/g, "_")
    // Collapse multiple underscores
    .replace(/_+/g, "_")
    // Trim leading/trailing underscores
    .replace(/^_|_$/g, "");
}

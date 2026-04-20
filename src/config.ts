/**
 * Configuration loader: reads codesight.config.(ts|js|json) from project root.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CodesightConfig } from "./types.js";

const CONFIG_FILES = [
  "codesight.config.ts",
  "codesight.config.js",
  "codesight.config.mjs",
  "codesight.config.json",
];

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load config from project root. Returns empty config if no config file found.
 */
export async function loadConfig(root: string): Promise<CodesightConfig> {
  for (const filename of CONFIG_FILES) {
    const configPath = join(root, filename);
    if (!(await fileExists(configPath))) continue;

    try {
      if (filename.endsWith(".json")) {
        const content = await readFile(configPath, "utf-8");
        return JSON.parse(content) as CodesightConfig;
      }

      if (filename.endsWith(".ts")) {
        // Try loading with tsx or ts-node if available
        return await loadTsConfig(configPath, root);
      }

      // JS/MJS — dynamic import
      const module = await import(pathToFileURL(configPath).href);
      return (module.default || module) as CodesightConfig;
    } catch (err: any) {
      console.warn(`  Warning: failed to load ${filename}: ${err.message}`);
      return {};
    }
  }

  // Also check package.json "codesight" field
  try {
    const pkgPath = join(root, "package.json");
    if (await fileExists(pkgPath)) {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      if (pkg.codesight && typeof pkg.codesight === "object") {
        return pkg.codesight as CodesightConfig;
      }
    }
  } catch {}

  return {};
}

function safeParseConfigText(content: string): CodesightConfig {
  const config: CodesightConfig = {};
  const match = content.match(/export\s+default\s+(\{[\s\S]*\})\s*;?\s*$/m);
  if (!match) return config;
  const body = match[1];

  function extractString(field: string): string | undefined {
    const m = body.match(new RegExp(`\\b${field}\\s*:\\s*['"\`]([^'"\`]*?)['"\`]`));
    return m ? m[1] : undefined;
  }
  function extractNumber(field: string): number | undefined {
    const m = body.match(new RegExp(`\\b${field}\\s*:\\s*(\\d+)`));
    return m ? parseInt(m[1], 10) : undefined;
  }
  function extractBoolean(field: string): boolean | undefined {
    const m = body.match(new RegExp(`\\b${field}\\s*:\\s*(true|false)`));
    return m ? m[1] === "true" : undefined;
  }
  function extractStringArray(field: string): string[] | undefined {
    const m = body.match(new RegExp(`\\b${field}\\s*:\\s*\\[([^\\]]*?)\\]`));
    if (!m) return undefined;
    const items = m[1].match(/['"`]([^'"`]*?)['"`]/g);
    return items ? items.map((s) => s.slice(1, -1)) : [];
  }

  const maxDepth = extractNumber("maxDepth");
  if (maxDepth !== undefined) config.maxDepth = maxDepth;
  const outputDir = extractString("outputDir");
  if (outputDir !== undefined) config.outputDir = outputDir;
  const profile = extractString("profile");
  if (profile !== undefined) config.profile = profile as CodesightConfig["profile"];
  const blastRadiusDepth = extractNumber("blastRadiusDepth");
  if (blastRadiusDepth !== undefined) config.blastRadiusDepth = blastRadiusDepth;
  const hotFileThreshold = extractNumber("hotFileThreshold");
  if (hotFileThreshold !== undefined) config.hotFileThreshold = hotFileThreshold;
  const maxTokens = extractNumber("maxTokens");
  if (maxTokens !== undefined) config.maxTokens = maxTokens;
  const collapseCrud = extractBoolean("collapseCrud");
  if (collapseCrud !== undefined) config.collapseCrud = collapseCrud;
  const disableDetectors = extractStringArray("disableDetectors");
  if (disableDetectors !== undefined) config.disableDetectors = disableDetectors;
  const ignorePatterns = extractStringArray("ignorePatterns");
  if (ignorePatterns !== undefined) config.ignorePatterns = ignorePatterns;

  return config;
}

async function loadTsConfig(configPath: string, _root: string): Promise<CodesightConfig> {
  // Strategy 1: try tsx via dynamic import of the .ts file directly
  // (works if tsx or ts-node is installed)
  try {
    const module = await import(pathToFileURL(configPath).href);
    return (module.default || module) as CodesightConfig;
  } catch {}

  // Strategy 2: read as text and extract known fields with safe regex parsing
  // (fallback for when no TS loader is available — avoids dynamic code execution)
  const content = await readFile(configPath, "utf-8");
  const parsed = safeParseConfigText(content);
  if (Object.keys(parsed).length > 0) return parsed;

  console.warn(
    `  Warning: cannot load codesight.config.ts (install tsx for full TS config support, or use codesight.config.json)`
  );
  return {};
}

/**
 * Merges CLI args with config file values (CLI takes precedence).
 */
export function mergeCliConfig(
  config: CodesightConfig,
  cli: { maxDepth?: number; outputDir?: string; profile?: string; maxTokens?: number }
): CodesightConfig {
  return {
    ...config,
    maxDepth: cli.maxDepth ?? config.maxDepth,
    outputDir: cli.outputDir ?? config.outputDir,
    profile: (cli.profile as CodesightConfig["profile"]) ?? config.profile,
    maxTokens: cli.maxTokens ?? config.maxTokens,
  };
}

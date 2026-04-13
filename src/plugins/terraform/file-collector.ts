import { readdir, readFile, stat } from "node:fs/promises";
import { join, dirname, resolve, extname } from "node:path";
import type { TerraformPluginConfig } from "./types.js";

const SKIP_DIRS = new Set([".terraform", ".git", "node_modules", ".terragrunt-cache"]);

export interface CollectedFiles {
  tfFiles: string[];
  tfvarsFiles: string[];
  basePath: string;
}

/**
 * Collect .tf and .tfvars files from the best-matching infrastructure location.
 * Tries: explicit config path → in-project subdirs → sibling repos → project root.
 */
export async function collectTfFiles(
  projectRoot: string,
  config: TerraformPluginConfig,
): Promise<CollectedFiles> {
  // 1. Explicit infraPath from config
  if (config.infraPath) {
    const resolved = resolve(projectRoot, config.infraPath);
    const files = await scanDirForTf(resolved);
    if (files.tfFiles.length > 0) return files;
  }

  // 2. In-project directories (common conventions)
  for (const subdir of ["terraform", "infra", "infrastructure", "deploy", "iac"]) {
    const candidate = join(projectRoot, subdir);
    const files = await scanDirForTf(candidate);
    if (files.tfFiles.length > 0) return files;
  }

  // 3. Sibling infrastructure repo
  const parent = dirname(projectRoot);
  for (const sibling of ["infrastructure", "infra", "terraform", "deploy"]) {
    const candidate = join(parent, sibling);
    const files = await scanDirForTf(candidate);
    if (files.tfFiles.length > 0) return files;
  }

  // 4. .tf files at project root
  const rootFiles = await scanDirForTf(projectRoot, 1);
  if (rootFiles.tfFiles.length > 0) return rootFiles;

  return { tfFiles: [], tfvarsFiles: [], basePath: projectRoot };
}

/**
 * Read a file's contents, returning empty string on failure.
 */
export async function readFileSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function scanDirForTf(dir: string, maxDepth = 5): Promise<CollectedFiles> {
  const tfFiles: string[] = [];
  const tfvarsFiles: string[] = [];

  try {
    await stat(dir);
  } catch {
    return { tfFiles, tfvarsFiles, basePath: dir };
  }

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(fullPath, depth + 1);
        }
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (ext === ".tf") {
          tfFiles.push(fullPath);
        } else if (ext === ".tfvars") {
          tfvarsFiles.push(fullPath);
        }
      }
    }
  }

  await walk(dir, 0);
  return { tfFiles, tfvarsFiles, basePath: dir };
}

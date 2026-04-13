import { writeFile, mkdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { scan } from "../core.js";
import { discoverPackages } from "./discover.js";
import { extractCrossPackageDeps, writeDepsFile } from "./deps.js";
import type { CodesightConfig } from "../types.js";

const GLOBAL_INDEX_FILENAME = "CODESIGHT.md";

/**
 * Run the full monorepo scan or refresh a single named package.
 * When targetPackage is provided, only that package is (re)scanned.
 */
export async function runMonorepoScan(
  root: string,
  userConfig: CodesightConfig,
  targetPackage?: string
): Promise<void> {
  const monorepoConfig = userConfig.monorepo ?? {};
  const outputDirName = userConfig.outputDir ?? ".codesight";
  const maxDepth = userConfig.maxDepth ?? 10;

  // Discover all qualifying packages
  let packages = await discoverPackages(root, monorepoConfig);

  // Collect all package names for cross-dep detection
  const allPackageNames = packages.map((p) => p.name);

  if (targetPackage) {
    const match = packages.find((p) => p.name === targetPackage);
    if (!match) {
      console.warn(`  codesight --refresh: package "${targetPackage}" not found or filtered out.`);
      return;
    }
    packages = [match];
  }

  console.log(`\n  codesight monorepo — scanning ${packages.length} package(s)\n`);

  for (const pkg of packages) {
    process.stdout.write(`  [${pkg.name}]...`);
    try {
      await scan(pkg.dir, outputDirName, maxDepth, userConfig, true /* quiet */);
      const deps = await extractCrossPackageDeps(pkg.dir, allPackageNames);
      await writeDepsFile(pkg.dir, deps, outputDirName);
      console.log(` done`);
    } catch (err: any) {
      console.error(` ERROR: ${err.message}`);
    }
  }

  // Write or refresh global index
  await writeGlobalIndex(root, packages.map((p) => p.dir), outputDirName);
  console.log(`\n  Global index updated: ${GLOBAL_INDEX_FILENAME}\n`);
}

async function writeGlobalIndex(
  root: string,
  qualifyingPackageDirs: string[],
  outputDirName: string
): Promise<void> {
  // Only list packages that actually have a .codesight/ directory
  const confirmed: string[] = [];
  for (const dir of qualifyingPackageDirs) {
    try {
      await stat(join(dir, outputDirName));
      confirmed.push(relative(root, dir));
    } catch {}
  }

  confirmed.sort();

  const lines = [
    "# CodeSight — Monorepo Index",
    "",
    "This project uses per-package CodeSight context files. Before using grep/find",
    "to explore a package, check if `.codesight/CODESIGHT.md` exists in that",
    "package's directory — it will be faster and cheaper.",
    "",
    "## Packages with CodeSight context",
    "",
    ...confirmed,
    "",
  ];

  await writeFile(join(root, GLOBAL_INDEX_FILENAME), lines.join("\n"), "utf-8");
}

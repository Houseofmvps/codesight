import { watch } from "node:fs";
import { join, relative } from "node:path";
import { scan } from "../core.js";
import { discoverPackages } from "./discover.js";
import { extractCrossPackageDeps, writeDepsFile } from "./deps.js";
import type { CodesightConfig } from "../types.js";
import type { PackageInfo } from "./discover.js";

const WATCH_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".vue", ".svelte", ".rb",
  ".json", ".yaml", ".yml", ".toml", ".env",
  ".prisma", ".graphql", ".gql",
]);

const DEBOUNCE_MS = 500;

/**
 * Start a single monorepo-root watcher that dispatches file-change events
 * to per-package rebuilds. Runs until SIGINT (Ctrl+C).
 */
export async function watchMonorepo(
  root: string,
  userConfig: CodesightConfig
): Promise<void> {
  const monorepoConfig = userConfig.monorepo ?? {};
  const outputDirName = userConfig.outputDir ?? ".codesight";
  const maxDepth = userConfig.maxDepth ?? 10;

  // Discover packages upfront to build the dispatch map
  let packages = await discoverPackages(root, monorepoConfig);
  const allPackageNames = packages.map((p) => p.name);

  // Build sorted list of package dirs for prefix matching (longest first)
  const sortedDirs = packages.map((p) => p.dir).sort((a, b) => b.length - a.length);

  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  console.log(`  codesight monorepo watch — watching ${packages.length} packages (Ctrl+C to stop)\n`);

  const watcher = watch(root, { recursive: true }, (eventType, filename) => {
    if (!filename) return;

    const absPath = join(root, filename);

    // Skip output dirs, node_modules, hidden dirs
    if (
      filename.includes("node_modules") ||
      filename.includes(`/${outputDirName}/`) ||
      filename.startsWith(".") ||
      filename.includes("/.")
    ) return;

    // Skip non-code files
    const lastDot = filename.lastIndexOf(".");
    if (lastDot === -1) return;
    const ext = filename.slice(lastDot);
    if (!WATCH_EXTENSIONS.has(ext)) return;

    // Find which package this file belongs to
    const packageDir = sortedDirs.find((d) => absPath.startsWith(d + "/"));
    if (!packageDir) return;

    // Debounce per package
    const existing = debounceTimers.get(packageDir);
    if (existing) clearTimeout(existing);

    debounceTimers.set(
      packageDir,
      setTimeout(async () => {
        debounceTimers.delete(packageDir);
        await rebuildPackage(packageDir, packages, allPackageNames, root, outputDirName, maxDepth, userConfig);
      }, DEBOUNCE_MS)
    );
  });

  process.on("SIGINT", () => {
    watcher.close();
    console.log("\n  codesight watch stopped.");
    process.exit(0);
  });

  // Keep process alive
  await new Promise<void>(() => {});
}

async function rebuildPackage(
  packageDir: string,
  packages: PackageInfo[],
  allPackageNames: string[],
  root: string,
  outputDirName: string,
  maxDepth: number,
  userConfig: CodesightConfig
): Promise<void> {
  const pkg = packages.find((p) => p.dir === packageDir);
  if (!pkg) return;

  process.stdout.write(`  [${pkg.name}] rebuilding...`);
  try {
    await scan(packageDir, outputDirName, maxDepth, userConfig, true /* quiet */);
    const deps = await extractCrossPackageDeps(packageDir, allPackageNames);
    await writeDepsFile(packageDir, deps, outputDirName);
    console.log(` done`);
  } catch (err: any) {
    console.error(` ERROR: ${err.message}`);
  }

  // Refresh global index after each package rebuild
  await refreshGlobalIndex(root, packages, outputDirName);
}

async function refreshGlobalIndex(
  root: string,
  packages: PackageInfo[],
  outputDirName: string
): Promise<void> {
  const { writeFile, stat } = await import("node:fs/promises");
  const confirmed: string[] = [];
  for (const pkg of packages) {
    try {
      await stat(join(pkg.dir, outputDirName));
      confirmed.push(relative(root, pkg.dir));
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
  await writeFile(join(root, "CODESIGHT.md"), lines.join("\n"), "utf-8");
}

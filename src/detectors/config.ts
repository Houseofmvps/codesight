import { readFile } from "node:fs/promises";
import { relative, join, basename } from "node:path";
import { readFileSafe } from "../scanner.js";
import type { ConfigInfo, EnvVar, ProjectInfo } from "../types.js";

const CONFIG_FILES = [
  "tsconfig.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "vite.config.ts",
  "vite.config.js",
  "tailwind.config.ts",
  "tailwind.config.js",
  "drizzle.config.ts",
  "wrangler.toml",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Dockerfile",
  ".env.example",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "railway.json",
  "vercel.json",
  "fly.toml",
  "render.yaml",
];

export async function detectConfig(
  files: string[],
  project: ProjectInfo
): Promise<ConfigInfo> {
  // Find config files
  const configFiles = files
    .filter((f) => {
      const name = basename(f);
      return CONFIG_FILES.includes(name);
    })
    .map((f) => relative(project.root, f));

  // Also check root for config files that might not have code extensions
  for (const cf of CONFIG_FILES) {
    const content = await readFileSafe(join(project.root, cf));
    if (content) {
      const rel = cf;
      if (!configFiles.includes(rel)) configFiles.push(rel);
    }
  }

  // Roku channel `manifest` files are plain-text key/value configs — surface
  // them in configFiles. Covers both root-level and per-creator channels.
  if (project.frameworks.includes("roku-scenegraph")) {
    const manifestHits = files.filter((f) => basename(f) === "manifest");
    for (const m of manifestHits) {
      const rel = relative(project.root, m);
      if (!configFiles.includes(rel)) configFiles.push(rel);
    }
    // Root-level manifest may not be in `files` (no extension filter) — check
    // directly for Roku monorepos whose channels live at nested paths.
    const rootManifest = await readFileSafe(join(project.root, "manifest"));
    if (rootManifest && /^\s*title\s*=/m.test(rootManifest) && !configFiles.includes("manifest")) {
      configFiles.push("manifest");
    }
  }

  // Detect env vars
  const envVars = await detectEnvVars(files, project);

  // Detect dependencies
  let dependencies: Record<string, string> = {};
  let devDependencies: Record<string, string> = {};
  try {
    const pkg = JSON.parse(
      await readFile(join(project.root, "package.json"), "utf-8")
    );
    dependencies = pkg.dependencies || {};
    devDependencies = pkg.devDependencies || {};
  } catch {}

  return {
    envVars,
    configFiles: configFiles.sort(),
    dependencies,
    devDependencies,
  };
}

async function detectEnvVars(
  files: string[],
  project: ProjectInfo
): Promise<EnvVar[]> {
  const envMap = new Map<string, EnvVar>();

  // Parse .env.example and .env files for declarations
  const envFiles = files.filter(
    (f) =>
      basename(f) === ".env" ||
      basename(f) === ".env.example" ||
      basename(f) === ".env.local"
  );

  for (const file of envFiles) {
    const content = await readFileSafe(file);
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
      if (match) {
        const name = match[1];
        const hasDefault = trimmed.includes("=") && trimmed.split("=")[1].trim().length > 0;
        envMap.set(name, {
          name,
          source: relative(project.root, file),
          hasDefault,
        });
      }
    }
  }

  // Scan code for process.env.VAR_NAME or os.environ["VAR_NAME"] or os.Getenv("VAR_NAME")
  const codeFiles = files.filter(
    (f) =>
      f.match(/\.(ts|js|tsx|jsx|mjs|cjs|py|go)$/) &&
      !f.includes("node_modules")
  );

  for (const file of codeFiles) {
    const content = await readFileSafe(file);
    const rel = relative(project.root, file);

    // process.env.VAR_NAME or process.env["VAR_NAME"]
    const nodeEnvPattern = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
    let match;
    while ((match = nodeEnvPattern.exec(content)) !== null) {
      const name = match[1];
      if (!envMap.has(name)) {
        envMap.set(name, { name, source: rel, hasDefault: false });
      }
    }

    const nodeEnvBracket = /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g;
    while ((match = nodeEnvBracket.exec(content)) !== null) {
      const name = match[1];
      if (!envMap.has(name)) {
        envMap.set(name, { name, source: rel, hasDefault: false });
      }
    }

    // Bun.env.VAR_NAME
    const bunEnvPattern = /Bun\.env\.([A-Z_][A-Z0-9_]*)/g;
    while ((match = bunEnvPattern.exec(content)) !== null) {
      const name = match[1];
      if (!envMap.has(name)) {
        envMap.set(name, { name, source: rel, hasDefault: false });
      }
    }

    // import.meta.env.VITE_VAR_NAME
    const viteEnvPattern = /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g;
    while ((match = viteEnvPattern.exec(content)) !== null) {
      const name = match[1];
      if (!envMap.has(name)) {
        envMap.set(name, { name, source: rel, hasDefault: false });
      }
    }

    // Python: os.environ["VAR"] or os.environ.get("VAR") or os.getenv("VAR")
    const pyEnvPattern =
      /os\.(?:environ\[['"]|environ\.get\s*\(['"]|getenv\s*\(['"])([A-Z_][A-Z0-9_]*)['"]/g;
    while ((match = pyEnvPattern.exec(content)) !== null) {
      const name = match[1];
      if (!envMap.has(name)) {
        envMap.set(name, { name, source: rel, hasDefault: false });
      }
    }

    // Go: os.Getenv("VAR")
    const goEnvPattern = /os\.Getenv\(["']([A-Z_][A-Z0-9_]*)["']\)/g;
    while ((match = goEnvPattern.exec(content)) !== null) {
      const name = match[1];
      if (!envMap.has(name)) {
        envMap.set(name, { name, source: rel, hasDefault: false });
      }
    }
  }

  // ─── Roku config sources ────────────────────────────────────────────────
  //
  // Roku apps don't use .env files — their runtime configuration lives in:
  //   1. `manifest` (key=value, one entry per line) at the channel root
  //   2. `appConfig.brs` (initConfig / initAppConfig functions returning an
  //      associative array of constants)
  // Both are surfaced as EnvVars so the AI context map highlights them.
  if (project.frameworks.includes("roku-scenegraph")) {
    const manifestFiles = files.filter((f) => basename(f) === "manifest");
    // Fallback: check the root manifest directly too.
    const rootManifestPath = join(project.root, "manifest");
    try {
      const rootManifest = await readFileSafe(rootManifestPath);
      if (rootManifest && /^\s*title\s*=/m.test(rootManifest)) {
        manifestFiles.push(rootManifestPath);
      }
    } catch {}

    for (const mfile of manifestFiles) {
      const content = await readFileSafe(mfile);
      if (!content) continue;
      const source = relative(project.root, mfile) || "manifest";
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const m = trimmed.match(/^([A-Za-z_][\w]*)\s*=\s*(.*)$/);
        if (!m) continue;
        const name = `manifest.${m[1]}`;
        const hasDefault = m[2].trim().length > 0;
        if (!envMap.has(name)) envMap.set(name, { name, source, hasDefault });
      }
    }

    // appConfig.brs: recognise `CONSTANT_NAME: "value"` or `name = "value"` in
    // init*Config functions. Only capture keys that look like config constants
    // (UPPER_SNAKE_CASE) to avoid noisy captures of local variables.
    const appConfigFiles = files.filter((f) => /appConfig\.brs$/i.test(f));
    const constPattern = /\b([A-Z][A-Z0-9_]{2,})\s*[:=]\s*["']([^"']*)["']/g;
    for (const file of appConfigFiles) {
      const content = await readFileSafe(file);
      if (!content) continue;
      const source = relative(project.root, file).replace(/\\/g, "/");
      let m: RegExpExecArray | null;
      while ((m = constPattern.exec(content)) !== null) {
        const name = m[1];
        if (envMap.has(name)) continue;
        envMap.set(name, { name, source, hasDefault: m[2].length > 0 });
      }
    }
  }

  return Array.from(envMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

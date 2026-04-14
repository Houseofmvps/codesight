import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, relative, basename, extname } from "node:path";
import { createHash } from "node:crypto";
import type {
  Framework,
  ORM,
  ComponentFramework,
  ProjectInfo,
  RepoType,
  WorkspaceInfo,
} from "./types.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  "dist",
  "build",
  "out",
  ".output",
  "coverage",
  ".turbo",
  ".vercel",
  ".codesight",
  ".codescope",
  ".ai-codex",
  "vendor",
  ".cache",
  ".parcel-cache",
  ".gradle",
  "deps",      // Elixir / mix — equivalent to node_modules for Phoenix/Ecto projects
  "_build",    // Elixir / mix — compiled .beam artifacts, analogous to `dist`/`build`
  "target",    // Rust / cargo — build output, compiled binaries + cached deps
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".vue",
  ".svelte",
  ".rb",
  ".ex",
  ".exs",
  ".java",
  ".kt",
  ".rs",
  ".php",
  ".dart",
  ".swift",
  ".cs",
  // Additional file types for new detectors
  ".graphql",
  ".gql",
  ".proto",
  ".sql",
  ".md",
]);

/**
 * Read .codesightignore at the project root and return ignore patterns.
 * One glob pattern per line. Lines starting with # are comments.
 */
export async function readCodesightIgnore(root: string): Promise<string[]> {
  try {
    const content = await readFile(join(root, ".codesightignore"), "utf-8");
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * File hash cache — persists per-file content hashes so incremental scans
 * only reprocess files that changed. Cache stored in .codesight/cache.json.
 */
export interface FileHashCache {
  version: number;
  hashes: Record<string, string>; // relative path -> sha1 hash
}

export async function loadFileHashCache(outputDir: string): Promise<FileHashCache> {
  try {
    const raw = await readFile(join(outputDir, "cache.json"), "utf-8");
    return JSON.parse(raw) as FileHashCache;
  } catch {
    return { version: 1, hashes: {} };
  }
}

export async function saveFileHashCache(outputDir: string, cache: FileHashCache): Promise<void> {
  try {
    await writeFile(join(outputDir, "cache.json"), JSON.stringify(cache, null, 2));
  } catch {
    // Non-fatal — cache is a perf optimization only
  }
}

export function hashFileContent(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 12);
}

export async function collectFiles(
  root: string,
  maxDepth = 10,
  ignorePatterns: string[] = []
): Promise<string[]> {
  const files: string[] = [];

  // Build a set of exact dir names to skip (simple patterns like "data", "fixtures")
  // Also support simple glob-style with trailing /* or /**
  const extraIgnore = new Set(
    ignorePatterns.map((p) => p.replace(/\/\*\*?$/, "").replace(/^\//, ""))
  );

  function shouldIgnoreDir(name: string, fullPath: string): boolean {
    if (IGNORE_DIRS.has(name)) return true;
    if (extraIgnore.has(name)) return true;
    // Check if any pattern matches a path segment
    const rel = fullPath.replace(root, "").replace(/^[/\\]/, "");
    for (const pattern of ignorePatterns) {
      const clean = pattern.replace(/\/\*\*?$/, "").replace(/^\//, "");
      if (rel === clean || rel.startsWith(clean + "/") || rel.startsWith(clean + "\\")) return true;
    }
    return false;
  }

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env" && entry.name !== ".env.example" && entry.name !== ".env.local") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldIgnoreDir(entry.name, fullPath)) continue;
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (CODE_EXTENSIONS.has(ext) || entry.name === ".env" || entry.name === ".env.example" || entry.name === ".env.local") {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(root, 0);
  return files;
}

export async function readFileSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

export async function detectProject(root: string): Promise<ProjectInfo> {
  const pkgPath = join(root, "package.json");
  let pkg: Record<string, any> = {};
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  } catch {}

  const name = pkg.name || await resolveRepoName(root);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  // Detect monorepo — also treat roots with subdirs containing non-JS manifests as monorepos
  const hasPnpmWorkspace = await fileExists(join(root, "pnpm-workspace.yaml"));
  let isMonorepo = !!(pkg.workspaces || hasPnpmWorkspace);
  const workspaces: WorkspaceInfo[] = [];

  if (isMonorepo) {
    const wsPatterns = await getWorkspacePatterns(root, pkg);
    for (const pattern of wsPatterns) {
      if (pattern.includes("*")) {
        // Glob pattern (e.g. "packages/*") — enumerate subdirectories
        const wsRoot = join(root, pattern.replace("/*", ""));
        try {
          const wsDirs = await readdir(wsRoot, { withFileTypes: true });
          for (const d of wsDirs) {
            if (!d.isDirectory() || d.name.startsWith(".")) continue;
            const wsPath = join(wsRoot, d.name);
            const wsInfo = await detectWorkspace(root, wsPath, d.name);
            if (wsInfo) workspaces.push(wsInfo);
          }
        } catch {}
      } else {
        // Direct path (e.g. "app", "api") — treat the path itself as a workspace
        const wsPath = join(root, pattern);
        try {
          const wsInfo = await detectWorkspace(root, wsPath, basename(pattern));
          if (wsInfo) workspaces.push(wsInfo);
        } catch {}
      }
    }
  }

  // Always scan top-level and depth-2 directories for implicit workspaces.
  // This catches undeclared backends in mixed repos and declared monorepos
  // whose workspace globs do not cover non-JS service paths.
  await discoverImplicitWorkspaces(root, workspaces);

  // Treat as implicit monorepo when multiple distinct stacks are found
  if (!isMonorepo && workspaces.length >= 2) isMonorepo = true;

  const repoType = await classifyRepoType(root, workspaces, isMonorepo);

  // Aggregate all workspace deps (always — not just for declared monorepos)
  let allDeps = { ...deps };
  for (const ws of workspaces) {
    const wsPkg = await readJsonSafe(join(root, ws.path, "package.json"));
    Object.assign(allDeps, wsPkg.dependencies, wsPkg.devDependencies);
  }

  // Detect language from root-level manifests + aggregated deps
  let language = await detectLanguage(root, allDeps);

  // Aggregate frameworks and orms from workspaces (always — not just for declared monorepos)
  let frameworks = await detectFrameworks(root, pkg);
  let orms = await detectORMs(root, pkg);
  for (const ws of workspaces) {
    for (const fw of ws.frameworks) {
      if (!frameworks.includes(fw)) frameworks.push(fw);
    }
    for (const orm of ws.orms) {
      if (!orms.includes(orm)) orms.push(orm);
    }
  }
  // Remove raw-http fallback if real frameworks were found from workspaces
  if (frameworks.length > 1 && frameworks.includes("raw-http")) {
    frameworks = frameworks.filter((fw) => fw !== "raw-http");
  }

  // Re-derive language for multi-stack repos where manifests live in subdirs,
  // not at root (e.g. backend/Package.swift → swift not detected at root level)
  if (workspaces.length >= 2) {
    const FW_LANG: Partial<Record<string, string>> = {
      vapor: "swift", swiftui: "swift",
      flutter: "dart",
      django: "python", flask: "python", fastapi: "python",
      rails: "ruby",
      phoenix: "elixir",
      spring: "java",
      ktor: "kotlin",
      laravel: "php", php: "php",
      actix: "rust", axum: "rust",
      aspnet: "csharp",
      gin: "go", fiber: "go", echo: "go", chi: "go", "go-net-http": "go",
    };
    const wsLangs = new Set<string>();
    if (language === "typescript" || language === "javascript" || allDeps["react"] || allDeps["typescript"]) {
      wsLangs.add(allDeps["typescript"] || deps["typescript"] ? "typescript" : "javascript");
    }
    for (const fw of frameworks) {
      const l = FW_LANG[fw];
      if (l) wsLangs.add(l);
    }
    if (wsLangs.size > 1) {
      if (language !== "mixed" && language !== "javascript" && wsLangs.has(language)) {
        // detectLanguage already resolved a primary language — keep it
      } else {
        language = "mixed";
      }
    } else if (wsLangs.size === 1) {
      language = wsLangs.values().next().value as typeof language;
    }
  }

  const jsOnlyFrameworks = new Set<Framework>([
    "next-app", "next-pages", "hono", "express", "fastify", "koa",
    "nestjs", "elysia", "adonis", "trpc", "sveltekit", "remix", "nuxt",
    "raw-http", "angular",
  ]);
  const nonJSLangs = new Set(["go", "python", "ruby", "elixir", "java", "kotlin", "rust", "php", "dart", "swift", "csharp"]);
  if (nonJSLangs.has(language) && frameworks.some((f) => !jsOnlyFrameworks.has(f))) {
    frameworks = frameworks.filter((f) => !jsOnlyFrameworks.has(f));
  }

  return {
    root,
    name,
    frameworks,
    orms,
    componentFramework: detectComponentFramework(allDeps, frameworks),
    isMonorepo,
    repoType,
    workspaces,
    language,
  };
}

async function discoverImplicitWorkspaces(
  repoRoot: string,
  workspaces: WorkspaceInfo[]
): Promise<void> {
  try {
    const topDirs = await readdir(repoRoot, { withFileTypes: true });
    for (const d of topDirs) {
      if (!d.isDirectory() || d.name.startsWith(".") || IGNORE_DIRS.has(d.name)) continue;
      const wsPath = join(repoRoot, d.name);

      if (await hasDirectWorkspaceManifest(wsPath)) {
        const wsInfo = await detectWorkspace(repoRoot, wsPath, d.name);
        if (wsInfo && !workspaces.some((w) => w.path === wsInfo.path)) {
          workspaces.push(wsInfo);
        }
      }

      // Depth-2 discovery — always runs, not as fallback. Catches nested
      // workspaces in container dirs (e.g. `repos/Engine/`, `apps/web/`,
      // `services/api/`, `container-dir/backend/`) even when the container
      // itself also matched via subdirectory manifest detection.
      try {
        const nestedDirs = await readdir(wsPath, { withFileTypes: true });
        for (const n of nestedDirs) {
          if (!n.isDirectory() || n.name.startsWith(".") || IGNORE_DIRS.has(n.name)) continue;
          const nestedPath = join(wsPath, n.name);
          if (!(await hasDirectWorkspaceManifest(nestedPath))) continue;
          const nestedInfo = await detectWorkspace(repoRoot, nestedPath, n.name);
          if (nestedInfo && !workspaces.some((w) => w.path === nestedInfo.path)) {
            workspaces.push(nestedInfo);
          }
        }
      } catch {}
    }
  } catch {}
}

/**
 * Classify the repo structure into one of: single, monorepo, microservices, meta.
 *
 * - meta:          .gitmodules exists → git submodules mean independent projects are
 *                  aggregated here (e.g. org-wide umbrella repos)
 * - microservices: multiple workspaces each with their own Dockerfile, or infra dirs
 *                  (k8s/, kubernetes/, helm/) are present alongside 2+ workspaces
 * - monorepo:      multiple workspaces under shared tooling (packages.json workspaces,
 *                  pnpm-workspace.yaml, turbo.json, nx.json, etc.)
 * - single:        single-project repo with no workspaces
 */
async function classifyRepoType(
  root: string,
  workspaces: WorkspaceInfo[],
  isMonorepo: boolean
): Promise<RepoType> {
  // Meta-repo: git submodules are the definitive signal
  if (await fileExists(join(root, ".gitmodules"))) return "meta";

  if (!isMonorepo || workspaces.length <= 1) return "single";

  // Microservices: 2+ workspaces each with a Dockerfile, or infra orchestration at root
  const infraDirs = ["k8s", "kubernetes", "helm"];
  for (const dir of infraDirs) {
    if (await fileExists(join(root, dir))) return "microservices";
  }

  let dockerfileCount = 0;
  for (const ws of workspaces) {
    if (await fileExists(join(root, ws.path, "Dockerfile"))) {
      dockerfileCount++;
      if (dockerfileCount >= 2) return "microservices";
    }
  }

  return "monorepo";
}

async function hasDirectWorkspaceManifest(dir: string): Promise<boolean> {
  const directManifestNames = [
    "package.json",
    "composer.json",
    "pubspec.yaml",
    "Package.swift",
    "requirements.txt",
    "Pipfile",
    "pyproject.toml",
    "mix.exs",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Gemfile",
  ];

  for (const manifest of directManifestNames) {
    if (await fileExists(join(dir, manifest))) return true;
  }

  try {
    const entries = await readdir(dir);
    return entries.some((entry) =>
      entry.endsWith(".xcodeproj") ||
      entry.endsWith(".xcworkspace") ||
      entry.endsWith(".csproj")
    );
  } catch {
    return false;
  }
}

async function detectFrameworks(
  root: string,
  pkg: Record<string, any>
): Promise<Framework[]> {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  let frameworks: Framework[] = [];

  // Next.js
  if (deps["next"]) {
    const hasAppDir =
      (await fileExists(join(root, "app"))) ||
      (await fileExists(join(root, "src/app")));
    const hasPagesDir =
      (await fileExists(join(root, "pages"))) ||
      (await fileExists(join(root, "src/pages")));
    if (hasAppDir) frameworks.push("next-app");
    if (hasPagesDir) frameworks.push("next-pages");
    if (!hasAppDir && !hasPagesDir) frameworks.push("next-app");
  }

  // Hono
  if (deps["hono"]) frameworks.push("hono");

  // Express
  if (deps["express"]) frameworks.push("express");

  // Fastify
  if (deps["fastify"]) frameworks.push("fastify");

  // Koa
  if (deps["koa"]) frameworks.push("koa");

  // NestJS
  if (deps["@nestjs/core"] || deps["@nestjs/common"]) frameworks.push("nestjs");

  // Elysia (Bun)
  if (deps["elysia"]) frameworks.push("elysia");

  // AdonisJS
  if (deps["@adonisjs/core"]) frameworks.push("adonis");

  // tRPC
  if (deps["@trpc/server"]) frameworks.push("trpc");

  // Angular
  if (deps["@angular/core"]) frameworks.push("angular");

  // SvelteKit
  if (deps["@sveltejs/kit"]) frameworks.push("sveltekit");

  // Remix
  if (deps["@remix-run/node"] || deps["@remix-run/react"]) frameworks.push("remix");

  // Nuxt
  if (deps["nuxt"]) frameworks.push("nuxt");

  // Python frameworks - check for requirements.txt or pyproject.toml
  const pyDeps = await getPythonDeps(root);
  if (pyDeps.includes("flask")) frameworks.push("flask");
  if (pyDeps.includes("fastapi")) frameworks.push("fastapi");
  if (pyDeps.includes("django")) frameworks.push("django");

  // Go frameworks — require both go.mod dep AND actual import in .go source files.
  // A dep in go.mod may be transitive or used only for utilities (e.g. go-chi/cors
  // without chi as a router), so we verify with a quick import grep.
  const goDeps = await getGoDeps(root);
  const goFwCandidates: { dep: string; importStr: string; fw: Framework }[] = [
    { dep: "gin-gonic/gin", importStr: `"github.com/gin-gonic/gin"`, fw: "gin" },
    { dep: "gofiber/fiber", importStr: `"github.com/gofiber/fiber`, fw: "fiber" },
    { dep: "labstack/echo", importStr: `"github.com/labstack/echo`, fw: "echo" },
    { dep: "go-chi/chi", importStr: `"github.com/go-chi/chi`, fw: "chi" },
  ];
  for (const candidate of goFwCandidates) {
    if (!goDeps.some((d) => d.includes(candidate.dep))) continue;
    if (await goImportUsed(root, candidate.importStr)) {
      frameworks.push(candidate.fw);
    }
  }
  if (goDeps.some((d) => d.includes("net/http"))) frameworks.push("go-net-http");

  // Ruby on Rails
  const hasGemfile = await fileExists(join(root, "Gemfile"));
  if (hasGemfile) {
    try {
      const gemfile = await readFile(join(root, "Gemfile"), "utf-8");
      if (gemfile.includes("rails")) frameworks.push("rails");
    } catch {}
  }

  // Phoenix (Elixir)
  const hasMixFile = await fileExists(join(root, "mix.exs"));
  if (hasMixFile) {
    try {
      const mix = await readFile(join(root, "mix.exs"), "utf-8");
      if (mix.includes("phoenix")) frameworks.push("phoenix");
    } catch {}
  }

  // Spring Boot (Java/Kotlin)
  const hasPomXml = await fileExists(join(root, "pom.xml"));
  const hasBuildGradle = await fileExists(join(root, "build.gradle")) || await fileExists(join(root, "build.gradle.kts"));
  if (hasPomXml || hasBuildGradle) {
    try {
      const buildFile = hasPomXml
        ? await readFile(join(root, "pom.xml"), "utf-8")
        : await readFile(join(root, hasBuildGradle ? "build.gradle.kts" : "build.gradle"), "utf-8");
      if (buildFile.includes("spring")) frameworks.push("spring");
      if (buildFile.includes("ktor")) frameworks.push("ktor");
    } catch {}
  }

  // Rust web frameworks
  const hasCargoToml = await fileExists(join(root, "Cargo.toml"));
  if (hasCargoToml) {
    try {
      const cargo = await readFile(join(root, "Cargo.toml"), "utf-8");
      if (cargo.includes("actix-web")) frameworks.push("actix");
      else if (cargo.includes("axum")) frameworks.push("axum");
    } catch {}
  }

  // Laravel vs generic PHP
  const hasComposerJson = await fileExists(join(root, "composer.json"));
  if (hasComposerJson) {
    try {
      const composer = await readFile(join(root, "composer.json"), "utf-8");
      if (composer.includes("laravel/framework")) {
        frameworks.push("laravel");
      } else {
        frameworks.push("php");
      }
    } catch {
      frameworks.push("php");
    }
  } else {
    // Check for .php files in root as fallback
    try {
      const hasPhpFiles = (await readdir(root)).some((e) => e.endsWith(".php"));
      if (hasPhpFiles) frameworks.push("php");
    } catch {}
  }

  // ASP.NET Core — search all .csproj files recursively (may be nested in src/)
  const allCsproj = await findAllCsproj(root);
  for (const csprojPath of allCsproj) {
    try {
      const content = await readFile(csprojPath, "utf-8");
      if (content.includes("Microsoft.AspNetCore")) {
        frameworks.push("aspnet");
        break;
      }
    } catch {}
  }
  // Fallback: .sln at root without any AspNetCore csproj → still a .NET project
  if (!frameworks.includes("aspnet") && allCsproj.length > 0) {
    try {
      const entries = await readdir(root);
      if (entries.some((e) => e.endsWith(".sln"))) frameworks.push("aspnet");
    } catch {}
  }

  // Flutter
  const hasPubspec = await fileExists(join(root, "pubspec.yaml"));
  if (hasPubspec) {
    try {
      const pubspec = await readFile(join(root, "pubspec.yaml"), "utf-8");
      if (pubspec.includes("flutter:") || pubspec.includes("flutter_")) {
        frameworks.push("flutter");
      }
    } catch {}
  }

  // Swift: Vapor vs SwiftUI
  const hasPackageSwift = await fileExists(join(root, "Package.swift"));
  if (hasPackageSwift) {
    try {
      const pkg = await readFile(join(root, "Package.swift"), "utf-8");
      if (pkg.includes("vapor/vapor") || pkg.includes('"vapor"')) {
        frameworks.push("vapor");
      } else {
        frameworks.push("swiftui");
      }
    } catch {
      frameworks.push("swiftui");
    }
  } else {
    // .xcodeproj presence → SwiftUI project
    try {
      const entries = await readdir(root);
      if (entries.some((e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"))) {
        frameworks.push("swiftui");
      }
    } catch {}
  }

  // Android
  const hasAndroidManifest =
    (await fileExists(join(root, "app", "src", "main", "AndroidManifest.xml"))) ||
    (await fileExists(join(root, "src", "main", "AndroidManifest.xml"))) ||
    (await fileExists(join(root, "AndroidManifest.xml")));
  if (hasAndroidManifest) {
    frameworks.push("android");
  } else if (hasBuildGradle) {
    // Check for com.android plugin in gradle
    for (const gp of ["build.gradle.kts", "build.gradle", "app/build.gradle.kts", "app/build.gradle"]) {
      try {
        const gc = await readFile(join(root, gp), "utf-8");
        if (/com\.android\.(?:application|library)/.test(gc)) {
          frameworks.push("android");
          break;
        }
      } catch {}
    }
  }

  // Fallback: detect raw http.createServer if no other frameworks found
  if (frameworks.length === 0) {
    frameworks.push("raw-http");
  }

  // Remove go-net-http if a specific Go framework was also detected
  const specificGoFrameworks = new Set(["gin", "fiber", "echo", "chi"]);
  if (frameworks.some((f) => specificGoFrameworks.has(f))) {
    frameworks = frameworks.filter((f) => f !== "go-net-http");
  }

  return frameworks;
}

async function detectORMs(
  root: string,
  pkg: Record<string, any>
): Promise<ORM[]> {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const orms: ORM[] = [];

  if (deps["drizzle-orm"]) orms.push("drizzle");
  if (deps["prisma"] || deps["@prisma/client"]) orms.push("prisma");
  if (deps["typeorm"]) orms.push("typeorm");
  if (deps["mongoose"]) orms.push("mongoose");
  if (deps["sequelize"]) orms.push("sequelize");

  const pyDeps = await getPythonDeps(root);
  if (pyDeps.includes("sqlalchemy") || pyDeps.includes("sqlmodel")) orms.push("sqlalchemy");
  // Django has a built-in ORM — detect it from framework list
  if (pyDeps.includes("django")) orms.push("django");

  const goDeps = await getGoDeps(root);
  if (goDeps.some((d) => d.includes("gorm"))) orms.push("gorm");
  if (goDeps.some((d) => d.includes("entgo.io/ent"))) orms.push("ent");

  // Rails ActiveRecord
  const hasGemfile = await fileExists(join(root, "Gemfile"));
  if (hasGemfile) {
    try {
      const gemfile = await readFile(join(root, "Gemfile"), "utf-8");
      if (gemfile.includes("activerecord") || gemfile.includes("rails")) orms.push("activerecord");
    } catch {}
  }

  // Phoenix Ecto
  const hasMixFile = await fileExists(join(root, "mix.exs"));
  if (hasMixFile) {
    try {
      const mix = await readFile(join(root, "mix.exs"), "utf-8");
      if (mix.includes("ecto")) orms.push("ecto");
    } catch {}
  }

  // Eloquent (Laravel — always bundled when laravel/framework is present)
  const composerPath = join(root, "composer.json");
  if (await fileExists(composerPath)) {
    try {
      const composer = await readFile(composerPath, "utf-8");
      if (composer.includes("laravel/framework")) orms.push("eloquent");
    } catch {}
  }

  // Exposed (Kotlin)
  const hasBuildGradleKts = await fileExists(join(root, "build.gradle.kts"));
  const hasBuildGradleKotlin = hasBuildGradleKts || await fileExists(join(root, "build.gradle"));
  if (hasBuildGradleKotlin) {
    try {
      const gradleFile = hasBuildGradleKts
        ? await readFile(join(root, "build.gradle.kts"), "utf-8")
        : await readFile(join(root, "build.gradle"), "utf-8");
      if (gradleFile.includes("exposed")) orms.push("exposed");
    } catch {}
  }

  // Room (Android)
  const androidDeps = await getAndroidDeps(root);
  if (androidDeps.some((d) => d.includes("androidx.room"))) orms.push("room");

  // Entity Framework (ASP.NET) — check all csproj files
  const allCsprojForOrm = await findAllCsproj(root);
  for (const cp of allCsprojForOrm) {
    try {
      const content = await readFile(cp, "utf-8");
      if (content.includes("EntityFramework") || content.includes("Microsoft.EntityFrameworkCore")) {
        orms.push("entity-framework");
        break;
      }
    } catch {}
  }

  return orms;
}

function detectComponentFramework(
  deps: Record<string, string>,
  frameworks: Framework[] = []
): ComponentFramework {
  if (deps["react"] || deps["react-dom"]) return "react";
  if (deps["vue"]) return "vue";
  if (deps["svelte"]) return "svelte";
  if (frameworks.includes("flutter")) return "flutter";
  if (frameworks.includes("android")) return "jetpack-compose";
  if (frameworks.includes("angular")) return "angular";
  return "unknown";
}

async function detectLanguage(
  root: string,
  deps: Record<string, string>
): Promise<"typescript" | "javascript" | "python" | "go" | "ruby" | "elixir" | "java" | "kotlin" | "rust" | "php" | "dart" | "swift" | "csharp" | "mixed"> {
  const hasTsConfig = await fileExists(join(root, "tsconfig.json"));
  const hasPyProject = await fileExists(join(root, "pyproject.toml")) || await fileExists(join(root, "backend/pyproject.toml"));
  const hasGoMod = await fileExists(join(root, "go.mod"));
  const hasRequirements = await fileExists(join(root, "requirements.txt")) || await fileExists(join(root, "backend/requirements.txt"));
  const hasGemfile = await fileExists(join(root, "Gemfile"));
  const hasMixExs = await fileExists(join(root, "mix.exs"));
  const hasPomXml = await fileExists(join(root, "pom.xml"));
  const hasBuildGradleKts = await fileExists(join(root, "build.gradle.kts"));
  const hasBuildGradle = hasBuildGradleKts || await fileExists(join(root, "build.gradle"));
  const isKotlinProject = hasBuildGradleKts || await fileExists(join(root, "src/main/kotlin")) ||
    await (async () => {
      try {
        const gradle = await readFile(join(root, "build.gradle"), "utf-8");
        return gradle.includes("kotlin(") || gradle.includes("org.jetbrains.kotlin");
      } catch { return false; }
    })();
  const hasCargoToml = await fileExists(join(root, "Cargo.toml"));
  const hasComposerJson = await fileExists(join(root, "composer.json"));
  const hasPubspec = await fileExists(join(root, "pubspec.yaml"));
  const hasPackageSwift = await fileExists(join(root, "Package.swift"));
  const hasCsproj = await (async () => {
    try { return (await readdir(root)).some((e) => e.endsWith(".csproj") || e.endsWith(".sln")); } catch { return false; }
  })();

  const langs: string[] = [];
  if (hasTsConfig || deps["typescript"]) langs.push("typescript");
  if (hasPyProject || hasRequirements) langs.push("python");
  if (hasGoMod) langs.push("go");
  if (hasGemfile) langs.push("ruby");
  if (hasMixExs) langs.push("elixir");
  if (hasBuildGradle && isKotlinProject) langs.push("kotlin");
  else if (hasBuildGradle || hasPomXml) langs.push("java");
  if (hasCargoToml) langs.push("rust");
  if (hasComposerJson) langs.push("php");
  if (hasPubspec) langs.push("dart");
  if (hasPackageSwift) langs.push("swift");
  if (hasCsproj) langs.push("csharp");

  if (langs.length > 1) {
    const primaryManifests: string[] = [
      "go", "rust", "ruby", "elixir", "swift", "dart", "csharp", "java", "kotlin", "php", "python",
    ];
    const primary = langs.filter((l) => primaryManifests.includes(l));
    if (primary.length === 1) return primary[0] as any;
    return "mixed";
  }
  if (langs.length === 1) return langs[0] as any;

  // Fallback: detect by file extensions present in root
  try {
    const entries = await readdir(root);
    if (entries.some((e) => e.endsWith(".php"))) return "php";
    if (entries.some((e) => e.endsWith(".swift"))) return "swift";
    if (entries.some((e) => e.endsWith(".cs"))) return "csharp";
    if (entries.some((e) => e.endsWith(".dart"))) return "dart";
  } catch {}

  return "javascript";
}

/**
 * Detect a workspace dir — handles both JS (package.json) and non-JS manifests.
 * Returns null if the dir has no recognisable project manifest.
 */
async function detectWorkspace(
  repoRoot: string,
  wsPath: string,
  dirName: string
): Promise<WorkspaceInfo | null> {
  // JS workspace
  const wsPkg = await readJsonSafe(join(wsPath, "package.json"));
  if (wsPkg.name || wsPkg.dependencies || wsPkg.devDependencies) {
    return {
      name: wsPkg.name || dirName,
      path: relative(repoRoot, wsPath),
      frameworks: await detectFrameworks(wsPath, wsPkg),
      orms: await detectORMs(wsPath, wsPkg),
    };
  }
  // Non-JS workspace (Laravel, Flutter, Swift, C#)
  return detectNonJSWorkspace(repoRoot, wsPath, dirName);
}

/**
 * Detect a non-JS workspace by checking for language-specific manifest files.
 * Returns null if none found (plain directory with no recognised project).
 */
async function detectNonJSWorkspace(
  repoRoot: string,
  wsPath: string,
  dirName: string
): Promise<WorkspaceInfo | null> {
  const frameworks: Framework[] = [];
  const orms: ORM[] = [];

  // Laravel / PHP
  const composerPath = join(wsPath, "composer.json");
  if (await fileExists(composerPath)) {
    try {
      const composer = await readFile(composerPath, "utf-8");
      if (composer.includes("laravel/framework")) {
        frameworks.push("laravel");
        orms.push("eloquent");
      } else {
        frameworks.push("php");
      }
    } catch {
      frameworks.push("php");
    }
  }

  // Flutter / Dart
  const pubspecPath = join(wsPath, "pubspec.yaml");
  if (await fileExists(pubspecPath)) {
    try {
      const pubspec = await readFile(pubspecPath, "utf-8");
      if (pubspec.includes("flutter:") || pubspec.includes("flutter_")) {
        frameworks.push("flutter");
      }
    } catch {
      frameworks.push("flutter");
    }
  }

  // Swift — Vapor or SwiftUI
  const packageSwiftPath = join(wsPath, "Package.swift");
  if (await fileExists(packageSwiftPath)) {
    try {
      const pkg = await readFile(packageSwiftPath, "utf-8");
      frameworks.push(pkg.includes("vapor/vapor") || pkg.includes('"vapor"') ? "vapor" : "swiftui");
    } catch {
      frameworks.push("swiftui");
    }
  } else {
    try {
      const entries = await readdir(wsPath);
      if (entries.some((e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"))) {
        frameworks.push("swiftui");
      }
    } catch {}
  }

  // C# / ASP.NET
  try {
    const entries = await readdir(wsPath);
    const csproj = entries.find((e) => e.endsWith(".csproj"));
    if (csproj) {
      const content = await readFile(join(wsPath, csproj), "utf-8");
      if (content.includes("Microsoft.AspNetCore") || content.includes("web")) {
        frameworks.push("aspnet");
      }
      if (content.includes("EntityFramework") || content.includes("Microsoft.EntityFrameworkCore")) {
        orms.push("entity-framework");
      }
    }
  } catch {}

  // Python frameworks - FastAPI, Flask, Django
  try {
    const pyDeps = await getPythonDeps(wsPath);
    if (pyDeps.includes("fastapi")) frameworks.push("fastapi");
    if (pyDeps.includes("sqlalchemy") || pyDeps.includes("sqlmodel")) orms.push("sqlalchemy");
    if (pyDeps.includes("flask")) frameworks.push("flask");
    if (pyDeps.includes("django")) {
      frameworks.push("django");
      orms.push("django");
    }
  } catch {}

  // Elixir / Phoenix / Ecto (workspace-level; mirrors existing root-level detection)
  const mixExsPath = join(wsPath, "mix.exs");
  if (await fileExists(mixExsPath)) {
    try {
      const mix = await readFile(mixExsPath, "utf-8");
      if (mix.includes(":phoenix") || mix.includes("phoenix,")) frameworks.push("phoenix");
      if (mix.includes(":ecto") || mix.includes("ecto_sql") || mix.includes("ecto,")) orms.push("ecto");
    } catch {}
  }

  // Rust web frameworks (workspace-level; mirrors existing root-level detection)
  const cargoTomlPath = join(wsPath, "Cargo.toml");
  if (await fileExists(cargoTomlPath)) {
    try {
      const cargo = await readFile(cargoTomlPath, "utf-8");
      if (cargo.includes("actix-web")) frameworks.push("actix");
      else if (cargo.includes("axum")) frameworks.push("axum");
    } catch {}
  }

  // Go web frameworks and ORMs (workspace-level)
  const goModPath = join(wsPath, "go.mod");
  if (await fileExists(goModPath)) {
    try {
      const goMod = await readFile(goModPath, "utf-8");
      if (goMod.includes("gin-gonic/gin")) frameworks.push("gin");
      else if (goMod.includes("gofiber/fiber")) frameworks.push("fiber");
      else if (goMod.includes("labstack/echo")) frameworks.push("echo");
      else if (goMod.includes("go-chi/chi")) frameworks.push("chi");
      else frameworks.push("go-net-http");
      if (goMod.includes("gorm")) orms.push("gorm");
      if (goMod.includes("entgo.io/ent")) orms.push("ent");
    } catch {}
  }

  // Spring Boot / Ktor (Java/Kotlin) (workspace-level)
  const pomXmlPath = join(wsPath, "pom.xml");
  const buildGradlePath = join(wsPath, "build.gradle");
  const buildGradleKtsPath = join(wsPath, "build.gradle.kts");
  const hasPom = await fileExists(pomXmlPath);
  const hasGradleKts = await fileExists(buildGradleKtsPath);
  const hasGradle = hasGradleKts || await fileExists(buildGradlePath);
  if (hasPom || hasGradle) {
    try {
      const buildFile = hasPom
        ? await readFile(pomXmlPath, "utf-8")
        : await readFile(hasGradleKts ? buildGradleKtsPath : buildGradlePath, "utf-8");
      if (buildFile.includes("spring")) frameworks.push("spring");
      if (buildFile.includes("ktor")) frameworks.push("ktor");
      if (buildFile.includes("exposed")) orms.push("exposed");
    } catch {}
  }

  // Rails (Ruby) (workspace-level)
  const gemfilePath = join(wsPath, "Gemfile");
  if (await fileExists(gemfilePath)) {
    try {
      const gemfile = await readFile(gemfilePath, "utf-8");
      if (gemfile.includes("rails")) frameworks.push("rails");
      if (gemfile.includes("activerecord") || gemfile.includes("rails")) orms.push("activerecord");
    } catch {}
  }

  if (frameworks.length === 0) return null;

  return {
    name: dirName,
    path: relative(repoRoot, wsPath),
    frameworks,
    orms,
  };
}

async function getWorkspacePatterns(
  root: string,
  pkg: Record<string, any>
): Promise<string[]> {
  // pnpm-workspace.yaml
  try {
    const yaml = await readFile(join(root, "pnpm-workspace.yaml"), "utf-8");
    const patterns: string[] = [];
    for (const line of yaml.split("\n")) {
      const match = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
      if (match) patterns.push(match[1].trim());
    }
    if (patterns.length > 0) return patterns;
  } catch {}

  // package.json workspaces
  if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
  if (pkg.workspaces?.packages) return pkg.workspaces.packages;

  return [];
}

async function parsePythonRequirements(content: string, root: string, deps: string[]): Promise<void> {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Follow -r includes one level deep
    const includeMatch = trimmed.match(/^-r\s+(.+)/);
    if (includeMatch) {
      try {
        const included = await readFile(join(root, includeMatch[1].trim()), "utf-8");
        for (const subLine of included.split("\n")) {
          const name = subLine.split(/[>=<\[#]/)[0].trim().toLowerCase().replace(/-/g, "-");
          if (name && !name.startsWith("-") && !deps.includes(name)) deps.push(name);
        }
      } catch {}
      continue;
    }
    const name = trimmed.split(/[>=<\[#]/)[0].trim().toLowerCase();
    if (name && !name.startsWith("-") && !deps.includes(name)) deps.push(name);
  }
}

async function getPythonDeps(root: string): Promise<string[]> {
  const deps: string[] = [];
  // Check root and common subdirectories
  const searchDirs = [root];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !IGNORE_DIRS.has(entry.name)) {
        searchDirs.push(join(root, entry.name));
      }
    }
  } catch {}
  for (const dir of searchDirs) {
    try {
      const req = await readFile(join(dir, "requirements.txt"), "utf-8");
      await parsePythonRequirements(req, dir, deps);
    } catch {}
    // Pipfile support (poetry-style, older Flask/Python projects)
    try {
      const pipfile = await readFile(join(dir, "Pipfile"), "utf-8");
      let inPackages = false;
      for (const line of pipfile.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "[packages]" || trimmed === "[dev-packages]") {
          inPackages = trimmed === "[packages]";
          continue;
        }
        if (trimmed.startsWith("[")) { inPackages = false; continue; }
        if (inPackages && trimmed.includes("=")) {
          const name = trimmed.split("=")[0].trim().toLowerCase().replace(/_/g, "-");
          if (name && !name.startsWith("#") && !deps.includes(name)) deps.push(name);
        }
      }
    } catch {}
    try {
      const toml = await readFile(join(dir, "pyproject.toml"), "utf-8");
      parsePyprojectProjectDeps(toml, deps);
      parsePyprojectPoetryDeps(toml, deps);
    } catch {}
  }
  return deps;
}

/** PEP 621: [project] dependencies = [...] */
function parsePyprojectProjectDeps(toml: string, deps: string[]): void {
  const projectIdx = toml.indexOf("[project]");
  if (projectIdx < 0) return;

  const afterProject = toml.slice(projectIdx);
  const depMatch = afterProject.match(/\bdependencies\s*=\s*\[/);
  if (!depMatch) return;

  // Bracket counting to handle packages with extras like django[bcrypt]
  const arrStart = projectIdx + (depMatch.index ?? 0) + depMatch[0].length - 1;
  let depth = 1;
  let pos = arrStart + 1;
  let inStr = false;
  while (pos < toml.length && depth > 0) {
    const ch = toml[pos];
    if (ch === '"' && toml[pos - 1] !== "\\") inStr = !inStr;
    if (!inStr) {
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
    }
    pos++;
  }
  const depsContent = toml.slice(arrStart + 1, pos - 1);
  for (const m of depsContent.matchAll(/"([^"]+)"/g)) {
    addPythonDep(m[1].split(/[>=<\[!~;]/)[0], deps);
  }
}

/** Poetry: [tool.poetry.dependencies] — key = "version" pairs */
function parsePyprojectPoetryDeps(toml: string, deps: string[]): void {
  const sectionMatch = toml.match(/^\[tool\.poetry\.dependencies\]\s*$/m);
  if (!sectionMatch) return;

  const sectionStart = (sectionMatch.index ?? 0) + sectionMatch[0].length;
  const sectionBody = toml.slice(sectionStart);
  for (const line of sectionBody.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) break;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const rawName = trimmed.slice(0, eqIdx).trim().replace(/^['"]|['"]$/g, "");
    addPythonDep(rawName, deps);
  }
}

function addPythonDep(rawName: string, deps: string[]): void {
  const name = rawName.trim().toLowerCase().replace(/_/g, "-");
  if (!name || name === "python" || name.startsWith("#") || deps.includes(name)) return;
  deps.push(name);
}

async function goImportUsed(root: string, importStr: string): Promise<boolean> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "vendor" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) {
        if (await goImportUsed(fullPath, importStr)) return true;
      } else if (entry.name.endsWith(".go")) {
        try {
          const content = await readFile(fullPath, "utf-8");
          if (content.includes(importStr)) return true;
        } catch {}
      }
    }
  } catch {}
  return false;
}

async function getGoDeps(root: string, includeIndirect = false): Promise<string[]> {
  const deps: string[] = [];
  try {
    const gomod = await readFile(join(root, "go.mod"), "utf-8");
    for (const line of gomod.split("\n")) {
      if (!includeIndirect && line.includes("// indirect")) continue;
      // Block format:  \t github.com/pkg/name v1.2.3
      let match = line.match(/^\s+([\w./-]+)\s+v/);
      if (!match) {
        // Single-line format: require github.com/pkg/name v1.2.3
        match = line.match(/^require\s+([\w./-]+)\s+v/);
      }
      if (match) deps.push(match[1]);
    }
    // Check for net/http usage in main.go
    try {
      const main = await readFile(join(root, "main.go"), "utf-8");
      if (main.includes("net/http")) deps.push("net/http");
    } catch {}
  } catch {}
  return deps;
}

async function getAndroidDeps(root: string): Promise<string[]> {
  const deps: string[] = [];
  const gradlePaths = [
    join(root, "build.gradle.kts"),
    join(root, "build.gradle"),
    join(root, "app", "build.gradle.kts"),
    join(root, "app", "build.gradle"),
  ];
  for (const gp of gradlePaths) {
    try {
      const content = await readFile(gp, "utf-8");
      const depPat = /(?:implementation|api|kapt|ksp|annotationProcessor)\s*\(?["']([^"']+)["']\)?/g;
      let m: RegExpExecArray | null;
      while ((m = depPat.exec(content)) !== null) {
        deps.push(m[1]);
      }
    } catch {}
  }
  return deps;
}

/**
 * Resolve the repo name, handling git worktrees.
 * In a worktree, basename(root) is a random name — resolve the actual repo instead.
 */
async function resolveRepoName(root: string): Promise<string> {
  try {
    // Check if .git is a file (worktree) vs directory (normal repo)
    const gitPath = join(root, ".git");
    const gitStat = await stat(gitPath);

    if (gitStat.isFile()) {
      // Worktree: .git is a file containing "gitdir: /path/to/main/.git/worktrees/name"
      const gitContent = await readFile(gitPath, "utf-8");
      const gitdirMatch = gitContent.match(/gitdir:\s*(.+)/);
      if (gitdirMatch) {
        // Resolve back to main repo: /repo/.git/worktrees/name -> /repo
        const worktreeGitDir = gitdirMatch[1].trim();
        // Go up from .git/worktrees/name to the repo root
        const mainGitDir = join(worktreeGitDir, "..", "..");
        const mainRepoRoot = join(mainGitDir, "..");
        return basename(mainRepoRoot);
      }
    }
  } catch {}

  // Fallback: use directory name
  return basename(root);
}

/** Recursively collect all .csproj files up to maxDepth levels deep. */
async function findAllCsproj(dir: string, depth = 0, results: string[] = []): Promise<string[]> {
  if (depth > 4) return results;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const skipDirs = new Set(["node_modules", ".git", "bin", "obj", "out", "dist", "build", ".vs"]);
    for (const e of entries) {
      if (e.name.endsWith(".csproj")) results.push(join(dir, e.name));
      else if (e.isDirectory() && !skipDirs.has(e.name)) {
        await findAllCsproj(join(dir, e.name), depth + 1, results);
      }
    }
  } catch {}
  return results;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(path: string): Promise<Record<string, any>> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return {};
  }
}

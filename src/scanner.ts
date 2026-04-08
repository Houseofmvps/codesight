import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, basename, extname } from "node:path";
import type {
  Framework,
  ORM,
  ComponentFramework,
  ProjectInfo,
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
]);

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
  const isMonorepo = !!(pkg.workspaces || hasPnpmWorkspace);
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
  } else {
    // Even without a declared monorepo manifest, scan top-level subdirs for
    // non-JS workspaces (e.g. SwiftUI + Laravel side-by-side in one repo)
    try {
      const topDirs = await readdir(root, { withFileTypes: true });
      for (const d of topDirs) {
        if (!d.isDirectory() || d.name.startsWith(".") || IGNORE_DIRS.has(d.name)) continue;
        const wsPath = join(root, d.name);
        const wsInfo = await detectNonJSWorkspace(root, wsPath, d.name);
        if (wsInfo) workspaces.push(wsInfo);
      }
    } catch {}
  }

  // For monorepos, aggregate all workspace deps for top-level detection
  let allDeps = { ...deps };
  if (isMonorepo) {
    for (const ws of workspaces) {
      const wsPkg = await readJsonSafe(join(root, ws.path, "package.json"));
      Object.assign(allDeps, wsPkg.dependencies, wsPkg.devDependencies);
    }
  }

  // Detect language
  const language = await detectLanguage(root, allDeps);

  // For monorepos, aggregate frameworks and orms from workspaces
  let frameworks = await detectFrameworks(root, pkg);
  let orms = await detectORMs(root, pkg);
  if (isMonorepo) {
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
  }

  return {
    root,
    name,
    frameworks,
    orms,
    componentFramework: detectComponentFramework(allDeps, frameworks),
    isMonorepo,
    workspaces,
    language,
  };
}

async function detectFrameworks(
  root: string,
  pkg: Record<string, any>
): Promise<Framework[]> {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const frameworks: Framework[] = [];

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

  // Go frameworks - check go.mod
  const goDeps = await getGoDeps(root);
  if (goDeps.some((d) => d.includes("net/http"))) frameworks.push("go-net-http");
  if (goDeps.some((d) => d.includes("gin-gonic/gin"))) frameworks.push("gin");
  if (goDeps.some((d) => d.includes("gofiber/fiber"))) frameworks.push("fiber");
  if (goDeps.some((d) => d.includes("labstack/echo"))) frameworks.push("echo");
  if (goDeps.some((d) => d.includes("go-chi/chi"))) frameworks.push("chi");

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

  // ASP.NET Core
  const hasCsprojOrSln =
    (await fileExists(join(root, "*.csproj")).then(() => false).catch(() => false)) ||
    (await (async () => {
      try {
        const entries = await readdir(root);
        return entries.some((e) => e.endsWith(".csproj") || e.endsWith(".sln"));
      } catch { return false; }
    })());
  if (hasCsprojOrSln) {
    try {
      const entries = await readdir(root);
      const csproj = entries.find((e) => e.endsWith(".csproj"));
      if (csproj) {
        const content = await readFile(join(root, csproj), "utf-8");
        if (content.includes("Microsoft.AspNetCore") || content.includes("web")) {
          frameworks.push("aspnet");
        }
      }
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

  // Fallback: detect raw http.createServer if no other frameworks found
  if (frameworks.length === 0) {
    frameworks.push("raw-http");
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
  if (pyDeps.includes("sqlalchemy")) orms.push("sqlalchemy");
  // Django has a built-in ORM — detect it from framework list
  if (pyDeps.includes("django")) orms.push("django");

  const goDeps = await getGoDeps(root);
  if (goDeps.some((d) => d.includes("gorm"))) orms.push("gorm");

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

  // Entity Framework (ASP.NET)
  try {
    const entries = await readdir(root);
    const csproj = entries.find((e) => e.endsWith(".csproj"));
    if (csproj) {
      const content = await readFile(join(root, csproj), "utf-8");
      if (content.includes("EntityFramework") || content.includes("Microsoft.EntityFrameworkCore")) {
        orms.push("entity-framework");
      }
    }
  } catch {}

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
  const hasBuildGradle = await fileExists(join(root, "build.gradle")) || await fileExists(join(root, "build.gradle.kts"));
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
  if (hasBuildGradle) langs.push("kotlin");
  else if (hasPomXml) langs.push("java");
  if (hasCargoToml) langs.push("rust");
  if (hasComposerJson) langs.push("php");
  if (hasPubspec) langs.push("dart");
  if (hasPackageSwift) langs.push("swift");
  if (hasCsproj) langs.push("csharp");

  if (langs.length > 1) return "mixed";
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

async function getPythonDeps(root: string): Promise<string[]> {
  const deps: string[] = [];
  // Check root and common subdirectories
  const searchDirs = [root, join(root, "backend"), join(root, "api"), join(root, "server"), join(root, "src")];
  for (const dir of searchDirs) {
    try {
      const req = await readFile(join(dir, "requirements.txt"), "utf-8");
      for (const line of req.split("\n")) {
        const name = line.split(/[>=<\[]/)[0].trim().toLowerCase();
        if (name && !deps.includes(name)) deps.push(name);
      }
    } catch {}
    try {
      const toml = await readFile(join(dir, "pyproject.toml"), "utf-8");
      // Find [project] section then locate dependencies = [...]
      // Use bracket counting to handle packages with extras like django[bcrypt]
      const projectIdx = toml.indexOf("[project]");
      if (projectIdx >= 0) {
        const afterProject = toml.slice(projectIdx);
        const depMatch = afterProject.match(/\bdependencies\s*=\s*\[/);
        if (depMatch) {
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
            const name = m[1].split(/[>=<\[!~;]/)[0].trim().toLowerCase();
            if (name && !deps.includes(name)) deps.push(name);
          }
        }
      }
    } catch {}
  }
  return deps;
}

async function getGoDeps(root: string): Promise<string[]> {
  const deps: string[] = [];
  try {
    const gomod = await readFile(join(root, "go.mod"), "utf-8");
    for (const line of gomod.split("\n")) {
      const match = line.match(/^\s*([\w./-]+)\s+v/);
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

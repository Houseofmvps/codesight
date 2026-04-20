import { relative, dirname, resolve, extname } from "node:path";
import { readFileSafe } from "../scanner.js";
import type { DependencyGraph, ImportEdge, ProjectInfo } from "../types.js";

export async function detectDependencyGraph(
  files: string[],
  project: ProjectInfo
): Promise<DependencyGraph> {
  const edges: ImportEdge[] = [];
  const importCount = new Map<string, number>();

  const codeFiles = files.filter((f) =>
    f.match(/\.(ts|tsx|js|jsx|mjs|py|go|rb|ex|exs|java|kt|rs|php|brs|bs|xml)$/)
  );

  // Build a lookup map for faster resolution: relative path -> true
  const relPathSet = new Set<string>();
  const relPaths: string[] = [];
  for (const file of files) {
    const rel = relative(project.root, file);
    relPathSet.add(rel);
    relPaths.push(rel);
  }

  for (const file of codeFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;

    const rel = relative(project.root, file);
    const ext = extname(file);

    if (ext === ".py") {
      extractPythonImports(content, rel, edges, importCount);
    } else if (ext === ".go") {
      extractGoImports(content, rel, edges, importCount);
    } else if (ext === ".rb") {
      extractRubyImports(content, rel, edges, importCount);
    } else if (ext === ".ex" || ext === ".exs") {
      extractElixirImports(content, rel, edges, importCount);
    } else if (ext === ".java" || ext === ".kt") {
      extractJavaImports(content, rel, edges, importCount, relPaths);
    } else if (ext === ".rs") {
      extractRustImports(content, rel, edges, importCount);
    } else if (ext === ".brs") {
      // BrightScript has no top-level imports; dependency edges come from the
      // paired XML via <script uri="pkg:/..." />. Skip here — XML branch picks
      // up the inbound edges for this file.
    } else if (ext === ".bs") {
      extractBrighterScriptImportsInline(content, rel, edges, importCount, relPathSet);
    } else if (ext === ".xml") {
      extractSceneGraphImportsInline(content, rel, edges, importCount, relPathSet);
    } else {
      extractTSImports(content, rel, file, project, relPathSet, edges, importCount);
    }
  }

  // Sort by most imported
  const hotFiles = Array.from(importCount.entries())
    .map(([file, count]) => ({ file, importedBy: count }))
    .sort((a, b) => b.importedBy - a.importedBy)
    .slice(0, 20);

  return { edges, hotFiles };
}

function extractTSImports(
  content: string,
  rel: string,
  absPath: string,
  project: ProjectInfo,
  relPathSet: Set<string>,
  edges: ImportEdge[],
  importCount: Map<string, number>
) {
  // Match: import ... from "./path" or import("./path") or require("./path")
  const patterns = [
    /(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const importPath = match[1];

      // Only track local imports (starting with . or @/ alias)
      if (!importPath.startsWith(".") && !importPath.startsWith("@/") && !importPath.startsWith("~/")) continue;

      // Resolve to relative path
      let resolvedPath: string;
      if (importPath.startsWith("@/") || importPath.startsWith("~/")) {
        resolvedPath = importPath.replace(/^[@~]\//, "src/");
      } else {
        const dir = dirname(absPath);
        resolvedPath = relative(project.root, resolve(dir, importPath));
      }

      // Strip .js/.mjs extension that TypeScript adds for ESM compatibility
      // e.g., import { foo } from "./bar.js" actually refers to ./bar.ts
      const stripped = resolvedPath.replace(/\.(js|mjs|cjs)$/, "");

      const normalized = normalizeImportPath(stripped, relPathSet);
      if (normalized && normalized !== rel) {
        edges.push({ from: rel, to: normalized });
        importCount.set(normalized, (importCount.get(normalized) || 0) + 1);
      }
    }
  }
}

function extractPythonImports(
  content: string,
  rel: string,
  edges: ImportEdge[],
  importCount: Map<string, number>
) {
  // from .module import something or from ..package.module import something
  const fromPattern = /^from\s+(\.+\w[\w.]*)\s+import/gm;
  let match: RegExpExecArray | null;
  while ((match = fromPattern.exec(content)) !== null) {
    const target = match[1].replace(/\./g, "/") + ".py";
    edges.push({ from: rel, to: target });
    importCount.set(target, (importCount.get(target) || 0) + 1);
  }
}

function extractGoImports(
  content: string,
  rel: string,
  edges: ImportEdge[],
  importCount: Map<string, number>
) {
  const importBlock = content.match(/import\s*\(([\s\S]*?)\)/);
  if (!importBlock) return;

  const lines = importBlock[1].split("\n");
  for (const line of lines) {
    const pathMatch = line.match(/["']([^"']+)["']/);
    if (pathMatch && pathMatch[1].includes("/") && !pathMatch[1].startsWith("github.com") && !pathMatch[1].includes(".")) {
      const target = pathMatch[1];
      edges.push({ from: rel, to: target });
      importCount.set(target, (importCount.get(target) || 0) + 1);
    }
  }
}

function extractRubyImports(
  content: string,
  rel: string,
  edges: ImportEdge[],
  importCount: Map<string, number>
) {
  // require_relative "./path"
  const pattern = /require_relative\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const target = match[1].replace(/^\.\//, "") + ".rb";
    edges.push({ from: rel, to: target });
    importCount.set(target, (importCount.get(target) || 0) + 1);
  }
}

function extractElixirImports(
  content: string,
  rel: string,
  edges: ImportEdge[],
  importCount: Map<string, number>
) {
  // alias MyApp.Accounts.User
  const pattern = /(?:alias|import|use)\s+([\w.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const mod = match[1];
    // Convert module path to potential file: MyApp.Accounts.User -> lib/my_app/accounts/user.ex
    if (mod.includes(".") && !mod.startsWith("Ecto") && !mod.startsWith("Phoenix") && !mod.startsWith("Plug")) {
      const target = "lib/" + mod.split(".").map(s =>
        s.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "")
      ).join("/") + ".ex";
      edges.push({ from: rel, to: target });
      importCount.set(target, (importCount.get(target) || 0) + 1);
    }
  }
}

function extractJavaImports(
  content: string,
  rel: string,
  edges: ImportEdge[],
  importCount: Map<string, number>,
  relPaths: string[]
) {
  // import com.myapp.service.UserService;
  const pattern = /^import\s+([\w.]+);/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const imp = match[1];
    // Skip standard library and common third-party
    if (imp.startsWith("java.") || imp.startsWith("javax.") || imp.startsWith("org.springframework") || imp.startsWith("org.apache")) continue;
    // Convert to path pattern: com.myapp.service.UserService -> UserService
    const className = imp.split(".").pop()!;
    const found = relPaths.find(p => p.endsWith(`/${className}.java`) || p.endsWith(`/${className}.kt`));
    if (found && found !== rel) {
      edges.push({ from: rel, to: found });
      importCount.set(found, (importCount.get(found) || 0) + 1);
    }
  }
}

function extractRustImports(
  content: string,
  rel: string,
  edges: ImportEdge[],
  importCount: Map<string, number>
) {
  // mod my_module; or use crate::my_module::something;
  const modPattern = /^mod\s+(\w+)\s*;/gm;
  let match: RegExpExecArray | null;
  while ((match = modPattern.exec(content)) !== null) {
    const dir = dirname(rel);
    const target = dir === "." ? `${match[1]}.rs` : `${dir}/${match[1]}.rs`;
    edges.push({ from: rel, to: target });
    importCount.set(target, (importCount.get(target) || 0) + 1);
  }
}

function normalizeImportPath(
  importPath: string,
  relPathSet: Set<string>
): string | null {
  // Try exact match first
  if (relPathSet.has(importPath)) return importPath;

  // Try with extensions
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
  for (const ext of extensions) {
    if (relPathSet.has(importPath + ext)) return importPath + ext;
  }

  // Try index files
  for (const ext of extensions) {
    if (relPathSet.has(importPath + "/index" + ext)) return importPath + "/index" + ext;
  }

  return null;
}

// ─── Roku SceneGraph imports ──────────────────────────────────────────────────
//
// Roku dependency edges come from two places:
//   - <script uri="pkg:/source/utils/Utils.brs" /> in component XML
//   - `import "pkg:/source/utils/Utils.brs"` in BrighterScript (.bs) files
// Both forms use the `pkg:/` protocol. The root depends on the channel layout;
// common conventions put BRS files directly under the channel root or under
// a creator dir (src/apps/<creator>/). We normalize by stripping `pkg:/` and
// matching against any file whose relative path ends with the import target.

function extractSceneGraphImportsInline(
  content: string,
  rel: string,
  edges: ImportEdge[],
  importCount: Map<string, number>,
  relPathSet: Set<string>
): void {
  // Only SceneGraph XML declares script includes — bail early on non-SceneGraph XML
  if (!/<component\b/i.test(content) && !/<script\b/i.test(content)) return;
  const pattern = /<script\s+[^>]*\buri\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    const target = resolveRokuImport(m[1], relPathSet);
    if (target && target !== rel) {
      edges.push({ from: rel, to: target });
      importCount.set(target, (importCount.get(target) || 0) + 1);
    }
  }
}

function extractBrighterScriptImportsInline(
  content: string,
  rel: string,
  edges: ImportEdge[],
  importCount: Map<string, number>,
  relPathSet: Set<string>
): void {
  const pattern = /^\s*import\s+["']([^"']+)["']/gim;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    const target = resolveRokuImport(m[1], relPathSet);
    if (target && target !== rel) {
      edges.push({ from: rel, to: target });
      importCount.set(target, (importCount.get(target) || 0) + 1);
    }
  }
}

/**
 * Roku packaging flattens files under a channel root, then exposes them via
 * `pkg:/...` URIs. The same file might live at `src/apps/foo/source/Bar.brs`
 * in the repo. Strip the protocol and match against any known rel path that
 * ends with the target suffix.
 */
function resolveRokuImport(uri: string, relPathSet: Set<string>): string | null {
  const stripped = uri.replace(/^pkg:\/+/, "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!stripped) return null;
  // Exact match first (flat layout)
  if (relPathSet.has(stripped)) return stripped;
  // Suffix match — handles nested channel layouts like src/apps/<creator>/
  for (const candidate of relPathSet) {
    const normalized = candidate.replace(/\\/g, "/");
    if (normalized.endsWith("/" + stripped) || normalized === stripped) {
      return candidate;
    }
  }
  return null;
}

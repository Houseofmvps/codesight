/**
 * Generic, language-driven native-AST pass.
 *
 * Unlike the built-in detectors (which run per detected framework/ORM), this
 * pass routes files to plugins purely by file extension via the plugin registry,
 * so any language a plugin declares is handled — no framework detection needed.
 * It is the single place native plugins are dispatched.
 *
 * Results are merged with the built-in extractors in core.ts:
 *  - routes: additive (union, native-preferred dedup on method:path) when enabled
 *    via `all`/config; authoritative (native replaces built-in per file, with a
 *    fallback + warning when the plugin is empty for a file the built-in handled)
 *    when languages are explicitly named.
 *  - schemas: native-preferred dedup by name in both modes (SchemaModel carries no
 *    file provenance, so per-file authoritative replacement isn't possible).
 */
import { relative, extname } from "node:path";
import { readFileSafe } from "../scanner.js";
import { detectTags } from "./routes.js";
import {
  buildNativeRegistry,
  recordParseError,
  type NativeAstResolved,
  type NativeRegistry,
} from "../ast/native-loader.js";
import type { ProjectInfo, RouteInfo, SchemaModel, Framework } from "../types.js";

export interface NativeExtraction {
  routes: RouteInfo[];
  schemas: SchemaModel[];
  /** The registry used, for ownership checks during the merge. */
  registry: NativeRegistry;
}

/**
 * Run every enabled plugin over the files it claims (by extension). Returns native
 * routes/schemas (already stamped `confidence: "native"` by the adapter) plus the
 * registry. Inert (empty) when native AST is disabled or no plugin is registered.
 */
export async function detectNative(
  files: string[],
  project: ProjectInfo,
  resolved: NativeAstResolved
): Promise<NativeExtraction> {
  const registry = buildNativeRegistry(resolved);
  const routes: RouteInfo[] = [];
  const schemas: SchemaModel[] = [];
  if (registry.byExt.size === 0) return { routes, schemas, registry };

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const entry = registry.byExt.get(ext);
    if (!entry) continue;

    const content = await readFileSafe(file);
    if (!content) continue;
    const rel = relative(project.root, file);

    if (entry.plugin.routes) {
      try {
        const r = entry.plugin.routes(rel, content, "unknown" as Framework, detectTags(content));
        if (r && r.length) routes.push(...r);
      } catch (e) {
        recordParseError(resolved, entry.lang, "routes", rel, e);
      }
    }
    if (entry.plugin.schemas) {
      try {
        const s = entry.plugin.schemas(rel, content);
        if (s && s.length) schemas.push(...s);
      } catch (e) {
        recordParseError(resolved, entry.lang, "schemas", rel, e);
      }
    }
  }

  return { routes, schemas, registry };
}

/**
 * Merge native routes with built-in routes.
 * - additive: union, native-preferred dedup on method:path.
 * - authoritative: for a file owned by a native plugin, native results replace
 *   built-in results from that file; if the plugin was empty for an owned file
 *   the built-in DID extract, built-in stands and a warning is recorded.
 */
export function mergeNativeRoutes(
  builtin: RouteInfo[],
  native: RouteInfo[],
  resolved: NativeAstResolved,
  registry: NativeRegistry
): RouteInfo[] {
  if (native.length === 0 && !resolved.authoritative) return builtin;

  const seen = new Set<string>();
  const result: RouteInfo[] = [];
  const add = (r: RouteInfo) => {
    const key = `${r.method}:${r.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(r);
  };

  for (const r of native) add(r); // native preferred

  if (resolved.authoritative) {
    const nativeFiles = new Set(native.map((r) => r.file));
    const warned = new Set<string>();
    for (const r of builtin) {
      const owned = registry.byExt.has(extname(r.file).toLowerCase());
      if (owned) {
        if (nativeFiles.has(r.file)) continue; // native authoritative for this file
        if (!warned.has(r.file)) {
          warned.add(r.file);
          warn(resolved, `native plugin found nothing in ${r.file}; using built-in extraction`);
        }
      }
      add(r);
    }
  } else {
    for (const r of builtin) add(r); // additive union
  }

  return result;
}

/** Merge native + built-in schemas, native-preferred dedup by model name. */
export function mergeNativeSchemas(builtin: SchemaModel[], native: SchemaModel[]): SchemaModel[] {
  if (native.length === 0) return builtin;
  const seen = new Set<string>();
  const result: SchemaModel[] = [];
  const add = (m: SchemaModel) => {
    const key = m.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(m);
  };
  for (const m of native) add(m);
  for (const m of builtin) add(m);
  return result;
}

function warn(resolved: NativeAstResolved, message: string): void {
  if (!resolved.warnings.includes(message)) resolved.warnings.push(message);
}

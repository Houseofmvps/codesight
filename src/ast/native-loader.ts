/**
 * Native-AST capability layer over the generic WASM plugin host.
 *
 * Resolves the user's `nativeAst` config into an effective mode + plugin search
 * path, and adapts a loaded plugin's raw JSON into codesight's domain types
 * (RouteInfo / SchemaModel / ImportEdge), stamping `confidence: "native"`.
 *
 * Everything here is inert unless native AST is explicitly enabled. With it off,
 * `resolveNativeAst` returns a shared disabled value and no plugin is ever loaded.
 */
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  NativeAstConfig,
  NativeLang,
  NativeKind,
  NativeDiagnostic,
  RouteInfo,
  SchemaModel,
  SchemaField,
  ImportEdge,
  ORM,
  Framework,
} from "../types.js";
import { loadPlugin } from "../wasm/plugin-host.js";

/** Effective, resolved native-AST settings for one scan. */
export interface NativeAstResolved {
  mode: false | "on" | "strict";
  /** Languages native parsing applies to. Empty set = all languages. */
  languages: Set<NativeLang>;
  /** Plugin directories searched in order (PATH-style waterfall). */
  pluginDirs: string[];
  /** Shared, mutable sink for strict-mode diagnostics. */
  diagnostics: NativeDiagnostic[];
}

/** A plugin adapted to codesight's domain types. Methods return null when the
 *  plugin produced nothing (caller falls back to the built-in parser). */
export interface NativePlugin {
  routes?(file: string, content: string, framework: Framework, tags: string[]): RouteInfo[] | null;
  schemas?(file: string, content: string): SchemaModel[] | null;
  imports?(file: string, content: string): ImportEdge[] | null;
}

const DISABLED: NativeAstResolved = {
  mode: false,
  languages: new Set(),
  pluginDirs: [],
  diagnostics: [],
};

// Memoized by the `nativeAst` config object reference. scan() passes the same
// userConfig to every detector, so they all share one resolved instance — and
// therefore one diagnostics array — without re-threading a resolved object.
const resolvedCache = new WeakMap<NativeAstConfig, NativeAstResolved>();

/**
 * Resolve raw config into effective settings. Returns a shared disabled value
 * when native AST is off. Memoized per config object so all detectors share the
 * same diagnostics sink.
 */
export function resolveNativeAst(
  cfg: NativeAstConfig | undefined,
  projectRoot: string
): NativeAstResolved {
  if (!cfg || !cfg.enabled) return DISABLED;

  const cached = resolvedCache.get(cfg);
  if (cached) return cached;

  const resolved: NativeAstResolved = {
    mode: cfg.enabled === "strict" ? "strict" : "on",
    languages: new Set(cfg.languages ?? []),
    pluginDirs: defaultPluginDirs(projectRoot, cfg.pluginDir),
    diagnostics: [],
  };
  resolvedCache.set(cfg, resolved);
  return resolved;
}

/** Ordered plugin search path. Explicit override first, then user/data dirs, then install dir. */
function defaultPluginDirs(projectRoot: string, override?: string): string[] {
  const dirs: string[] = [];
  if (override) {
    dirs.push(isAbsolute(override) ? override : resolve(projectRoot, override));
  }
  dirs.push(join(homedir(), ".codesight", "plugins"));
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  dirs.push(join(xdgData, "codesight", "plugins"));
  try {
    // dist/ast/native-loader.js → <pkg root>/plugins
    const here = fileURLToPath(import.meta.url);
    dirs.push(resolve(here, "..", "..", "..", "plugins"));
  } catch {
    /* import.meta.url unavailable — skip install-dir candidate */
  }
  return dirs;
}

/** Is native parsing enabled for this language under the resolved settings? */
export function nativeEnabledFor(r: NativeAstResolved, lang: NativeLang): boolean {
  return r.mode !== false && (r.languages.size === 0 || r.languages.has(lang));
}

export function isStrict(r: NativeAstResolved): boolean {
  return r.mode === "strict";
}

/**
 * Get the native plugin for (lang, kind), or null when native is disabled for
 * the language, no plugin is available, or the plugin doesn't support the kind.
 * Under strict mode, an expected-but-unavailable plugin records a single
 * diagnostic (deduped per lang+kind). Call once per sub-detector, not per file.
 */
export function nativePluginFor(
  lang: NativeLang,
  kind: NativeKind,
  r: NativeAstResolved
): NativePlugin | null {
  if (!nativeEnabledFor(r, lang)) return null;

  const plugin = getNativePlugin(lang, r);
  if (!plugin || typeof plugin[kind] !== "function") {
    if (r.mode === "strict") recordUnavailable(r, lang, kind);
    return null;
  }
  return plugin;
}

/** Record a per-file parse failure (strict mode). */
export function recordParseError(
  r: NativeAstResolved,
  lang: NativeLang,
  kind: NativeKind,
  file: string,
  err: unknown
): void {
  if (r.mode !== "strict") return;
  r.diagnostics.push({ lang, kind, file, reason: errMessage(err) });
}

/** CLI-formatted summary of strict-mode diagnostics, or "" when there are none. */
export function reportNativeDiagnostics(diagnostics: NativeDiagnostic[]): string {
  if (diagnostics.length === 0) return "";
  const lines = [
    `  Native-AST (strict): ${diagnostics.length} place(s) where a WASM plugin was expected but did not run:`,
  ];
  for (const d of diagnostics) {
    lines.push(`    - ${d.lang}/${d.kind}${d.file ? ` (${d.file})` : ""}: ${d.reason}`);
  }
  return lines.join("\n");
}

// ─── internals ───

function recordUnavailable(r: NativeAstResolved, lang: NativeLang, kind: NativeKind): void {
  const dup = r.diagnostics.some(
    (d) => d.lang === lang && d.kind === kind && !d.file && d.reason === "plugin unavailable"
  );
  if (!dup) r.diagnostics.push({ lang, kind, reason: "plugin unavailable" });
}

/**
 * Build a domain-typed adapter around the raw plugin, or null if unavailable.
 * A method is exposed only when the plugin exports the matching capability, so
 * `nativePluginFor` can detect "kind unsupported" via method presence.
 */
function getNativePlugin(lang: NativeLang, r: NativeAstResolved): NativePlugin | null {
  const loaded = loadPlugin(lang, r.pluginDirs);
  if (!loaded) return null;

  const np: NativePlugin = {};

  if (loaded.routes) {
    np.routes = (file, content, framework, tags) => {
      const raw = loaded.routes!(content);
      if (!Array.isArray(raw)) return null;
      return raw.map((x: any): RouteInfo => {
        const path = String(x?.path ?? "");
        return {
          method: String(x?.method ?? "ALL"),
          path,
          file,
          tags,
          framework,
          params: Array.isArray(x?.params) ? x.params.map(String) : extractPathParams(path),
          confidence: "native",
          ...(Array.isArray(x?.middleware) ? { middleware: x.middleware.map(String) } : {}),
        };
      });
    };
  }

  if (loaded.schemas) {
    np.schemas = (_file, content) => {
      const raw = loaded.schemas!(content);
      if (!Array.isArray(raw)) return null;
      return raw.map((m: any): SchemaModel => ({
        name: String(m?.name ?? ""),
        fields: (Array.isArray(m?.fields) ? m.fields : []).map((f: any): SchemaField => ({
          name: String(f?.name ?? ""),
          type: String(f?.type ?? "unknown"),
          flags: Array.isArray(f?.flags) ? f.flags.map(String) : [],
        })),
        relations: (Array.isArray(m?.relations) ? m.relations : []).map(String),
        orm: (m?.orm ?? "unknown") as ORM,
        confidence: "native",
      }));
    };
  }

  // `imports` is part of the published contract and exercised by the conformance
  // test, but no scan dispatches to it yet (see detectors/graph.ts).
  if (loaded.imports) {
    np.imports = (file, content) => {
      const raw = loaded.imports!(content);
      if (!Array.isArray(raw)) return null;
      return raw.map((x: any): ImportEdge => ({
        from: file,
        to: typeof x === "string" ? x : String(x?.to ?? ""),
      }));
    };
  }

  return np;
}

function extractPathParams(path: string): string[] {
  const params: string[] = [];
  const regex = /[:{<](?:\w+:)?(\w+)[}>]?/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(path)) !== null) params.push(m[1]);
  return params;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

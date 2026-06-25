/**
 * Capability-agnostic WASM plugin host.
 *
 * Loads and instantiates user-provided WebAssembly plugins and exposes their
 * per-kind `parse*` exports across a small ABI. A capability layer
 * (ast/native-loader.ts) maps the raw JSON each returns into codesight's domain
 * types.
 *
 * Plugins ship OUTSIDE this repo. Nothing here runs unless the user explicitly
 * enables native AST and a matching .wasm is found on the search path.
 *
 * Discovery (per language): <dir>/codesight-<lang>-ast.wasm
 *
 * ABI (exported-function "reactor", no imports). A conforming module exports:
 *   memory : WebAssembly.Memory
 *   alloc(len: i32) -> i32                 — reserve `len` bytes, return ptr
 *   dealloc(ptr: i32, len: i32)            — release a prior allocation
 *   contractVersion() -> i32               — must equal CONTRACT_VERSION, else skipped
 *   parseRoutes(srcPtr: i32, srcLen: i32)  -> i64   (optional — capability by presence)
 *   parseSchemas(srcPtr: i32, srcLen: i32) -> i64   (optional)
 *   parseImports(srcPtr: i32, srcLen: i32) -> i64   (optional; defined but not yet
 *                                                    dispatched during a scan)
 *
 * Each parse* returns (outPtr << 32) | outLen pointing at UTF-8 JSON in linear
 * memory; outLen == 0 means "nothing" (caller falls back). The module is
 * instantiated once and the parse functions are called per file — a reactor,
 * not a per-file process.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { NativeLang, PluginMetadata } from "../types.js";

// `node:wasi` is loaded lazily (below) rather than via a static import: importing
// it emits a one-time ExperimentalWarning at module-load, which would fire on
// every run. Deferring the load to first plugin use lets us install a targeted
// warning filter first, and avoids loading WASI at all when native AST is off.
const nodeRequire = createRequire(import.meta.url);

/** Capability namespace, part of the discovery filename: codesight-<lang>-<CAPABILITY>.wasm */
const CAPABILITY = "ast";
/** ABI/contract version the host understands. A plugin reporting a different value is skipped. */
const CONTRACT_VERSION = 1;

/**
 * A loaded, instantiated, version-validated plugin. A method is present iff the
 * module exported the corresponding parse* function. Each returns the plugin's
 * parsed JSON (any shape) for a source string, or null when it produced nothing.
 * Throws if the underlying wasm traps.
 */
export interface LoadedPlugin {
  routes?(source: string): unknown;
  schemas?(source: string): unknown;
  imports?(source: string): unknown;
  /** Self-reported metadata from the optional `describe()` export (if any). */
  metadata?: PluginMetadata;
}

/** Resolves a language to a LoadedPlugin (or null if none found). Swappable for tests. */
export type PluginProvider = (lang: NativeLang, pluginDirs: string[]) => LoadedPlugin | null;

/** A plugin binary found on the search path: its filename language id + path. */
export interface PluginFile {
  /** The `<lang>` captured from the filename — a discovery hint / fallback id. */
  lang: string;
  path: string;
}

/** Only files matching this template are ever considered plugins. */
const PLUGIN_FILENAME = /^codesight-([a-z0-9_-]+)-ast\.wasm$/;

/**
 * Enumerate plugin binaries across the search path (for `all` mode). Returns one
 * entry per filename language id, first-match-wins by waterfall dir order (lower
 * dirs shadowed), deterministic within a dir. Only template-matching files are
 * returned — arbitrary `.wasm` is ignored. Filesystem-only (a test provider is
 * for load-by-id, not enumeration).
 */
export function listPluginFiles(pluginDirs: string[]): PluginFile[] {
  const seen = new Set<string>();
  const out: PluginFile[] = [];
  for (const dir of pluginDirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue; // dir doesn't exist / unreadable
    }
    for (const name of entries) {
      const m = PLUGIN_FILENAME.exec(name);
      if (!m) continue;
      const lang = m[1];
      if (seen.has(lang)) continue; // waterfall first-wins
      seen.add(lang);
      out.push({ lang, path: join(dir, name) });
    }
  }
  return out;
}

// ─── Test seam ───
let providerOverride: PluginProvider | null = null;
/** Install a fake provider (tests). */
export function setNativePluginProvider(fn: PluginProvider | null): void {
  providerOverride = fn;
}
/** Remove a fake provider and drop the instance cache. */
export function resetNativePluginProvider(): void {
  providerOverride = null;
  cache.clear();
}

// Instance cache keyed by resolved .wasm path (or sentinel for "tried, not loadable").
const cache = new Map<string, LoadedPlugin | null>();

// node:wasi prints a one-time "ExperimentalWarning: WASI is an experimental
// feature..." to stderr when constructed. Suppress *only* that specific warning
// (installed lazily, the first time we actually use WASI) so it doesn't pollute
// CLI output — every other process warning passes through unchanged.
let wasiWarningSuppressed = false;
function suppressWasiExperimentalWarning(): void {
  if (wasiWarningSuppressed) return;
  wasiWarningSuppressed = true;
  const original = process.emitWarning.bind(process);
  (process as { emitWarning: unknown }).emitWarning = (warning: unknown, ...args: unknown[]) => {
    const opt = args[0];
    const type = opt && typeof opt === "object" ? (opt as { type?: string }).type : opt;
    const message = typeof warning === "string" ? warning : (warning as Error | undefined)?.message ?? "";
    if (type === "ExperimentalWarning" && String(message).includes("WASI")) return;
    return (original as (...a: unknown[]) => void)(warning, ...args);
  };
}

/**
 * Resolve + load the plugin for `lang`, searching `pluginDirs` in order. Returns
 * null when no plugin is available; a malformed/incompatible plugin is treated
 * as absent (never throws for that).
 */
export function loadPlugin(lang: NativeLang, pluginDirs: string[]): LoadedPlugin | null {
  if (providerOverride) return providerOverride(lang, pluginDirs);

  const wasmName = `codesight-${lang}-${CAPABILITY}.wasm`;
  let wasmPath: string | null = null;
  for (const dir of pluginDirs) {
    const candidate = join(dir, wasmName);
    if (existsSync(candidate)) {
      wasmPath = candidate;
      break;
    }
  }
  if (!wasmPath) return null;

  if (cache.has(wasmPath)) return cache.get(wasmPath) ?? null;

  let loaded: LoadedPlugin | null = null;
  try {
    const bytes = readFileSync(wasmPath);
    const module = new WebAssembly.Module(bytes);

    // Always instantiate with a WASI import object. Pure-compute (no-imports)
    // plugins ignore the extras; plugins whose runtime needs WASI (e.g. Go
    // reactors built with //go:wasmexport) get a minimal, capability-restricted
    // environment — NO filesystem, NO network, no args/env. node:wasi is built
    // in, so this keeps the zero-dependency constraint. "Plugins are pure
    // compute" — if a kind ever needs project context, it flows through the ABI,
    // not the filesystem.
    suppressWasiExperimentalWarning();
    const { WASI } = nodeRequire("node:wasi") as typeof import("node:wasi");
    const wasi = new WASI({ version: "preview1" });
    const instance = new WebAssembly.Instance(module, wasi.getImportObject() as WebAssembly.Imports);

    // Reactor modules (Go) export `_initialize` and must be initialized before
    // any other export is called. No-imports modules (Rust/AssemblyScript) have
    // neither `_initialize` nor `_start` and are used as-is.
    if (typeof (instance.exports as Record<string, unknown>)._initialize === "function") {
      wasi.initialize(instance);
    }

    loaded = bindExports(instance.exports);
  } catch {
    loaded = null; // unloadable plugin → treated as absent
  }
  cache.set(wasmPath, loaded);
  return loaded;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  contractVersion(): number;
  describe?(): bigint;
  parseRoutes?(srcPtr: number, srcLen: number): bigint;
  parseSchemas?(srcPtr: number, srcLen: number): bigint;
  parseImports?(srcPtr: number, srcLen: number): bigint;
}

/**
 * Validate a module's exports against the ABI and bind a LoadedPlugin, or return
 * null if it is not a compatible codesight plugin (missing core exports, or a
 * contractVersion that doesn't match the host). Exported for testing the gate
 * without compiling a variant module.
 */
export function bindExports(rawExports: unknown): LoadedPlugin | null {
  const ex = rawExports as WasmExports;
  if (!(ex.memory instanceof WebAssembly.Memory)) return null;
  if (typeof ex.alloc !== "function" || typeof ex.dealloc !== "function") return null;
  if (typeof ex.contractVersion !== "function") return null;

  let version: number;
  try {
    version = Number(ex.contractVersion());
  } catch {
    return null;
  }
  if (version !== CONTRACT_VERSION) return null;

  const dec = new TextDecoder();
  const enc = new TextEncoder();

  // Read a packed (outPtr<<32)|outLen return value into parsed JSON, freeing the
  // output buffer. Returns null on an empty result or invalid JSON.
  const readPacked = (packed: bigint): unknown => {
    const p = BigInt(packed);
    const outPtr = Number(BigInt.asUintN(32, p >> 32n));
    const outLen = Number(BigInt.asUintN(32, p));
    if (outLen === 0) return null;
    // Re-acquire the view — the call may have grown memory (detaches ArrayBuffer).
    const json = dec.decode(new Uint8Array(ex.memory.buffer, outPtr, outLen));
    ex.dealloc(outPtr, outLen);
    try {
      return JSON.parse(json);
    } catch {
      return null; // contract violation — treat as no result
    }
  };

  const bind = (fn: (p: number, l: number) => bigint) => (source: string): unknown => {
    const bytes = enc.encode(source);
    const ptr = ex.alloc(bytes.length) >>> 0;
    // Re-acquire the view after alloc — memory.grow detaches the ArrayBuffer.
    new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
    let packed: bigint;
    try {
      packed = fn(ptr, bytes.length); // may trap → throws
    } finally {
      ex.dealloc(ptr, bytes.length);
    }
    return readPacked(packed);
  };

  const plugin: LoadedPlugin = {};
  if (typeof ex.parseRoutes === "function") plugin.routes = bind(ex.parseRoutes);
  if (typeof ex.parseSchemas === "function") plugin.schemas = bind(ex.parseSchemas);
  if (typeof ex.parseImports === "function") plugin.imports = bind(ex.parseImports);

  // Optional self-description (no input). Carried for discovery/routing; a plugin
  // that omits it falls back to its filename id + a default extension map.
  if (typeof ex.describe === "function") {
    try {
      const meta = readPacked(ex.describe());
      if (meta && typeof meta === "object") plugin.metadata = meta as PluginMetadata;
    } catch {
      /* ignore a broken describe() — treat as no metadata */
    }
  }

  return plugin;
}

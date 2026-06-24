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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeLang } from "../types.js";

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
}

/** Resolves a language to a LoadedPlugin (or null if none found). Swappable for tests. */
export type PluginProvider = (lang: NativeLang, pluginDirs: string[]) => LoadedPlugin | null;

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
    const instance = new WebAssembly.Instance(module, {}); // no imports
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

    const p = BigInt(packed);
    const outPtr = Number(BigInt.asUintN(32, p >> 32n));
    const outLen = Number(BigInt.asUintN(32, p));
    if (outLen === 0) return null;

    // Re-acquire again — parse may have grown memory while building output.
    const json = dec.decode(new Uint8Array(ex.memory.buffer, outPtr, outLen));
    ex.dealloc(outPtr, outLen);
    try {
      return JSON.parse(json);
    } catch {
      return null; // contract violation — treat as no result
    }
  };

  const plugin: LoadedPlugin = {};
  if (typeof ex.parseRoutes === "function") plugin.routes = bind(ex.parseRoutes);
  if (typeof ex.parseSchemas === "function") plugin.schemas = bind(ex.parseSchemas);
  if (typeof ex.parseImports === "function") plugin.imports = bind(ex.parseImports);
  return plugin;
}

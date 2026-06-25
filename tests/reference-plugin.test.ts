import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// ABI conformance test for the reference WASM plugin.
//
// Drives the REAL host (dist/wasm/plugin-host.js + dist/ast/native-loader.js)
// against a real compiled wasm module. The wasm is resolved from
// CODESIGHT_REFERENCE_PLUGIN_DIR if set (CI points this at the freshly built
// artifact to catch drift), else the committed prebuilt under reference/.
//
// Run against a fresh build:
//   pnpm build:reference && pnpm exec tsx --test tests/reference-plugin.test.ts

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
// resolve() makes a relative env value (e.g. CI's "reference/ast-plugin") absolute,
// so it isn't re-resolved against a projectRoot in the adapter checks below.
const PLUGIN_DIR = resolve(process.env.CODESIGHT_REFERENCE_PLUGIN_DIR || join(REPO, "reference", "ast-plugin"));

const SRC = [
  "route GET /health",
  "route POST /users/{id}",
  "model User id email",
  "import ./db",
  "import ./models/user",
  "this line is ignored noise",
].join("\n");

async function loadModules() {
  const { loadPlugin, bindExports, listPluginFiles, resetNativePluginProvider } = await import("../dist/wasm/plugin-host.js");
  const { resolveNativeAst, nativePluginFor, buildNativeRegistry } = await import("../dist/ast/native-loader.js");
  const { detectNative } = await import("../dist/detectors/native.js");
  const { detectProject } = await import("../dist/scanner.js");
  return {
    loadPlugin, bindExports, listPluginFiles, resetNativePluginProvider,
    resolveNativeAst, nativePluginFor, buildNativeRegistry, detectNative, detectProject,
  };
}

describe("reference WASM plugin — raw ABI (plugin-host)", () => {
  let mods: any;
  before(async () => {
    mods = await loadModules();
    mods.resetNativePluginProvider(); // ensure the real loader, not a leftover mock
  });

  it("loads, exposes a capability per exported parse* function", async () => {
    const plugin = mods.loadPlugin("reference", [PLUGIN_DIR]);
    assert.ok(plugin, `expected to load codesight-reference-ast.wasm from ${PLUGIN_DIR}`);
    assert.equal(typeof plugin.routes, "function");
    assert.equal(typeof plugin.schemas, "function");
    assert.equal(typeof plugin.imports, "function");
  });

  it("parses each kind into the exact contract shapes", async () => {
    const plugin = mods.loadPlugin("reference", [PLUGIN_DIR]);

    assert.deepEqual(plugin.routes(SRC), [
      { method: "GET", path: "/health" },
      { method: "POST", path: "/users/{id}" },
    ]);

    assert.deepEqual(plugin.schemas(SRC), [
      {
        name: "User",
        fields: [
          { name: "id", type: "unknown", flags: [] },
          { name: "email", type: "unknown", flags: [] },
        ],
        relations: [],
        orm: "unknown",
      },
    ]);

    assert.deepEqual(plugin.imports(SRC), ["./db", "./models/user"]);
  });

  it("returns null (→ host fallback) when there are no markers", async () => {
    const plugin = mods.loadPlugin("reference", [PLUGIN_DIR]);
    assert.equal(plugin.routes("nothing to see here"), null);
  });
});

describe("reference WASM plugin — adapter (native-loader)", () => {
  let mods: any;
  before(async () => { mods = await loadModules(); mods.resetNativePluginProvider(); });

  it("maps routes to RouteInfo, stamps confidence, derives params", async () => {
    const resolved = mods.resolveNativeAst({ enabled: true, pluginDir: PLUGIN_DIR }, PLUGIN_DIR);
    const np = mods.nativePluginFor("reference", "routes", resolved);
    assert.ok(np?.routes, "expected a routes-capable adapter");

    const routes = np.routes("src/app.x", SRC, "unknown", ["auth"]);
    assert.equal(routes.length, 2);
    const byPath = Object.fromEntries(routes.map((r: any) => [r.path, r]));
    assert.deepEqual(byPath["/health"], {
      method: "GET", path: "/health", file: "src/app.x",
      tags: ["auth"], framework: "unknown", params: [], confidence: "native",
    });
    assert.deepEqual(byPath["/users/{id}"].params, ["id"]);
    assert.equal(byPath["/users/{id}"].confidence, "native");
  });

  it("maps schemas to SchemaModel and stamps confidence", async () => {
    const resolved = mods.resolveNativeAst({ enabled: true, pluginDir: PLUGIN_DIR }, PLUGIN_DIR);
    const np = mods.nativePluginFor("reference", "schemas", resolved);
    const models = np.schemas("src/models.x", SRC);
    assert.equal(models.length, 1);
    assert.equal(models[0].name, "User");
    assert.equal(models[0].confidence, "native");
    assert.deepEqual(models[0].fields.map((f: any) => f.name), ["id", "email"]);
  });

  it("exposes imports through the adapter (contract is wired even though no scan dispatches it)", async () => {
    const resolved = mods.resolveNativeAst({ enabled: true, pluginDir: PLUGIN_DIR }, PLUGIN_DIR);
    const np = mods.nativePluginFor("reference", "imports", resolved);
    assert.ok(np?.imports, "expected an imports-capable adapter");
    assert.deepEqual(np.imports("src/app.x", SRC), [
      { from: "src/app.x", to: "./db" },
      { from: "src/app.x", to: "./models/user" },
    ]);
  });
});

describe("plugin-host — contractVersion gating (bindExports)", () => {
  let mods: any;
  before(async () => { mods = await loadModules(); });

  const memory = () => new WebAssembly.Memory({ initial: 1 });
  const noop = () => {};
  const stubParse = () => 0n;

  it("accepts a matching contract version and binds capabilities by export presence", async () => {
    const plugin = mods.bindExports({
      memory: memory(), alloc: () => 0, dealloc: noop,
      contractVersion: () => 1, parseRoutes: stubParse,
    });
    assert.ok(plugin);
    assert.equal(typeof plugin.routes, "function");
    assert.equal(plugin.schemas, undefined); // no parseSchemas export → no capability
  });

  it("rejects an incompatible contract version", async () => {
    const plugin = mods.bindExports({
      memory: memory(), alloc: () => 0, dealloc: noop,
      contractVersion: () => 999, parseRoutes: stubParse,
    });
    assert.equal(plugin, null);
  });

  it("rejects a module missing the contractVersion export", async () => {
    const plugin = mods.bindExports({ memory: memory(), alloc: () => 0, dealloc: noop, parseRoutes: stubParse });
    assert.equal(plugin, null);
  });

  it("rejects a module missing core exports (memory)", async () => {
    const plugin = mods.bindExports({ alloc: () => 0, dealloc: noop, contractVersion: () => 1 });
    assert.equal(plugin, null);
  });
});

describe("native generalization — discovery + generic pass (reference plugin)", () => {
  let mods: any;
  before(async () => { mods = await loadModules(); mods.resetNativePluginProvider(); });

  const MARKERS = ["route GET /health", "model User id email", "import ./db"].join("\n");

  it("reads describe() metadata (languageId + extensions)", () => {
    const p = mods.loadPlugin("reference", [PLUGIN_DIR]);
    assert.ok(p, "reference plugin should load");
    assert.deepEqual(p.metadata, { languageId: "reference", extensions: [".ref"] });
  });

  it("buildNativeRegistry routes the declared extension to the plugin (explicit)", () => {
    const resolved = mods.resolveNativeAst({ enabled: true, languages: ["reference"], pluginDir: PLUGIN_DIR }, PLUGIN_DIR);
    const reg = mods.buildNativeRegistry(resolved);
    const entry = reg.byExt.get(".ref");
    assert.ok(entry, "expected .ref → reference in the registry");
    assert.equal(entry.lang, "reference");
    assert.equal(entry.authoritative, true); // explicit list ⇒ authoritative
  });

  it("the generic pass dispatches a .ref file by extension", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cs-gen-"));
    writeFileSync(join(tmp, "thing.ref"), MARKERS);
    const resolved = mods.resolveNativeAst({ enabled: true, languages: ["reference"], pluginDir: PLUGIN_DIR }, tmp);
    const { routes, schemas } = await mods.detectNative([join(tmp, "thing.ref")], { root: tmp }, resolved);
    assert.deepEqual(routes.map((r: any) => `${r.method} ${r.path}`), ["GET /health"]);
    assert.ok(routes.every((r: any) => r.confidence === "native" && r.framework === "unknown"));
    assert.deepEqual(schemas.map((s: any) => s.name), ["User"]);
  });

  it("`all` mode discovers the plugin by globbing the plugin dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cs-plugins-"));
    copyFileSync(join(PLUGIN_DIR, "codesight-reference-ast.wasm"), join(tmp, "codesight-reference-ast.wasm"));
    // no `languages` ⇒ all/additive; the override dir is searched first
    const resolved = mods.resolveNativeAst({ enabled: true, pluginDir: tmp }, tmp);
    const reg = mods.buildNativeRegistry(resolved);
    const entry = reg.byExt.get(".ref");
    assert.ok(entry, "all-mode should discover the reference plugin");
    assert.equal(entry.lang, "reference");
    assert.equal(entry.authoritative, false); // all ⇒ additive
  });
});

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
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
  const { loadPlugin, bindExports, resetNativePluginProvider } = await import("../dist/wasm/plugin-host.js");
  const { resolveNativeAst, nativePluginFor } = await import("../dist/ast/native-loader.js");
  return { loadPlugin, bindExports, resetNativePluginProvider, resolveNativeAst, nativePluginFor };
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

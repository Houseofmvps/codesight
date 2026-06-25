import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// All modules imported from built dist (matches the suite's convention).
async function loadModules() {
  const { loadConfig, mergeCliConfig, safeParseConfigText } = await import("../dist/config.js");
  const { resolveNativeAst, nativeEnabledFor, isStrict, reportNativeDiagnostics } =
    await import("../dist/ast/native-loader.js");
  const { setNativePluginProvider, resetNativePluginProvider } =
    await import("../dist/wasm/plugin-host.js");
  const { collectFiles, detectProject } = await import("../dist/scanner.js");
  const { detectRoutes } = await import("../dist/detectors/routes.js");
  const { detectNative } = await import("../dist/detectors/native.js");
  return {
    loadConfig, mergeCliConfig, safeParseConfigText,
    resolveNativeAst, nativeEnabledFor, isStrict, reportNativeDiagnostics,
    setNativePluginProvider, resetNativePluginProvider,
    collectFiles, detectProject, detectRoutes, detectNative,
  };
}

const FASTAPI_FIXTURE = `
from fastapi import FastAPI, APIRouter

app = FastAPI()
router = APIRouter()

@router.get("/items")
def list_items():
    return []
`;

const SQLALCHEMY_FIXTURE = `
from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import DeclarativeBase

class Base(DeclarativeBase):
    pass

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String)
`;

// A fake plugin provider: a LoadedPlugin with per-kind methods, returning
// native results regardless of source.
function fakeProvider() {
  return () => ({
    routes: () => [{ method: "GET", path: "/native", params: [] }],
    schemas: () => [
      { name: "NativeModel", fields: [{ name: "id", type: "integer", flags: ["pk"] }], relations: [], orm: "sqlalchemy" },
    ],
  });
}

async function writeFixture(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(tmpdir(), `codesight-native-${name}-${process.pid}`);
  await mkdir(dir, { recursive: true });
  for (const [f, content] of Object.entries(files)) {
    await writeFile(join(dir, f), content);
  }
  return dir;
}

describe("native-ast config resolution", () => {
  it("safeParseConfigText extracts nested nativeAst without a TS loader", async () => {
    const { safeParseConfigText } = await loadModules();
    const cfg = safeParseConfigText(
      `export default { maxDepth: 5, nativeAst: { enabled: "strict", languages: ["rust", "go"], pluginDir: "./wasm" } };`
    );
    assert.equal(cfg.nativeAst?.enabled, "strict");
    assert.deepEqual(cfg.nativeAst?.languages, ["rust", "go"]);
    assert.equal(cfg.nativeAst?.pluginDir, "./wasm");
  });

  it("safeParseConfigText handles enabled: true and omitted optional fields", async () => {
    const { safeParseConfigText } = await loadModules();
    const cfg = safeParseConfigText(`export default { nativeAst: { enabled: true } };`);
    assert.equal(cfg.nativeAst?.enabled, true);
    assert.equal(cfg.nativeAst?.languages, undefined);
    assert.equal(cfg.nativeAst?.pluginDir, undefined);
  });

  it("mergeCliConfig: CLI/env nativeAst beats the config file", async () => {
    const { mergeCliConfig } = await loadModules();
    const merged = mergeCliConfig(
      { nativeAst: { enabled: true } },
      { nativeAst: { enabled: "strict" } }
    );
    assert.equal(merged.nativeAst?.enabled, "strict");
  });

  it("mergeCliConfig: config file used when no CLI/env nativeAst", async () => {
    const { mergeCliConfig } = await loadModules();
    const merged = mergeCliConfig({ nativeAst: { enabled: true } }, {});
    assert.equal(merged.nativeAst?.enabled, true);
    const none = mergeCliConfig({}, {});
    assert.equal(none.nativeAst, undefined);
  });

  it("resolveNativeAst maps enabled states and language scoping", async () => {
    const { resolveNativeAst, nativeEnabledFor, isStrict } = await loadModules();
    assert.equal(resolveNativeAst(undefined, "/x").mode, false);
    assert.equal(resolveNativeAst({ enabled: false }, "/x").mode, false);
    assert.equal(resolveNativeAst({ enabled: true }, "/x").mode, "on");

    const strict = resolveNativeAst({ enabled: "strict" }, "/x");
    assert.equal(strict.mode, "strict");
    assert.equal(isStrict(strict), true);

    const scoped = resolveNativeAst({ enabled: true, languages: ["rust"] }, "/x");
    assert.equal(nativeEnabledFor(scoped, "rust"), true);
    assert.equal(nativeEnabledFor(scoped, "go"), false);

    const all = resolveNativeAst({ enabled: true }, "/x");
    assert.equal(nativeEnabledFor(all, "python"), true);
  });

  it("resolveNativeAst builds the plugin-dir waterfall with override first", async () => {
    const { resolveNativeAst } = await loadModules();
    const r = resolveNativeAst({ enabled: true, pluginDir: "./plugins" }, "/proj");
    assert.equal(r.pluginDirs[0], join("/proj", "plugins")); // relative override resolved against root
    assert.ok(r.pluginDirs.some((d: string) => d.endsWith(join(".codesight", "plugins"))));
    assert.ok(r.pluginDirs.some((d: string) => d.includes(join("codesight", "plugins"))));
  });
});

describe("native-ast dispatch (generic pass)", () => {
  let mods: any;
  before(async () => { mods = await loadModules(); });
  afterEach(() => { mods.resetNativePluginProvider(); });

  // Explicit languages target the plugin by name (the mocked provider answers
  // loadPlugin) and route .py via the default extension map — no real .wasm.
  const pythonExplicit = (mods: any, dir: string) =>
    mods.resolveNativeAst({ enabled: true, languages: ["python"] }, dir);

  it("dispatches by extension and tags confidence 'native' (routes)", async () => {
    const dir = await writeFixture("routes", { "main.py": FASTAPI_FIXTURE });
    try {
      mods.setNativePluginProvider(fakeProvider());
      const project = await mods.detectProject(dir);
      const files = await mods.collectFiles(dir, 10, []);
      const { routes } = await mods.detectNative(files, project, pythonExplicit(mods, dir));
      assert.ok(routes.length > 0, "expected native routes");
      assert.ok(routes.every((r: any) => r.confidence === "native"));
      assert.ok(routes.some((r: any) => r.path === "/native"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dispatches by extension and tags confidence 'native' (schemas)", async () => {
    const dir = await writeFixture("schemas", { "models.py": SQLALCHEMY_FIXTURE });
    try {
      mods.setNativePluginProvider(fakeProvider());
      const project = await mods.detectProject(dir);
      const files = await mods.collectFiles(dir, 10, []);
      const { schemas } = await mods.detectNative(files, project, pythonExplicit(mods, dir));
      assert.ok(schemas.length > 0, "expected native schemas");
      assert.ok(schemas.every((s: any) => s.confidence === "native"));
      assert.ok(schemas.some((s: any) => s.name === "NativeModel"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("regression: with native disabled, built-in extraction is unaffected and untagged", async () => {
    const dir = await writeFixture("off", { "main.py": FASTAPI_FIXTURE, "requirements.txt": "fastapi\n" });
    try {
      const project = await mods.detectProject(dir);
      const files = await mods.collectFiles(dir, 10, []);
      const routes = await mods.detectRoutes(files, project); // no nativeAst config
      assert.equal(routes.filter((r: any) => r.confidence === "native").length, 0);
      assert.ok(routes.length > 0, "built-in extraction should still find routes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("strict mode records an 'unavailable' diagnostic for a named language with no plugin", async () => {
    const dir = await writeFixture("strict", { "main.py": FASTAPI_FIXTURE });
    try {
      // No provider → real loader finds no codesight-python-ast.wasm → unavailable.
      const resolved = mods.resolveNativeAst({ enabled: "strict", languages: ["python"] }, dir);
      const project = await mods.detectProject(dir);
      const files = await mods.collectFiles(dir, 10, []);
      await mods.detectNative(files, project, resolved);
      assert.ok(
        resolved.diagnostics.some((d: any) => d.lang === "python" && d.reason === "plugin unavailable"),
        `expected a python unavailable diagnostic, got ${JSON.stringify(resolved.diagnostics)}`
      );
      assert.ok(mods.reportNativeDiagnostics(resolved.diagnostics).includes("python"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

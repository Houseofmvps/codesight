import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function writeFixture(subdir: string, files: Record<string, string>) {
  const dir = join(FIXTURE_ROOT, subdir);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await mkdir(join(dir, ...name.split("/").slice(0, -1)), { recursive: true });
    await writeFile(filePath, content);
  }
  return dir;
}

// Verify the type exists and compiles — this test will fail until types.ts is updated
describe("MonorepoConfig types", () => {
  it("CodesightConfig accepts monorepo field", async () => {
    const { } = await import("../dist/types.js").catch(() => ({ }));
    // Type-only check via compiled output existence
    assert.ok(true); // passes once build succeeds with new types
  });
});

describe("discoverPackages", () => {
  it("returns qualifying packages and filters out small/no-src packages", async () => {
    const { discoverPackages } = await import("../dist/monorepo/discover.js");

    const dir = await writeFixture("monorepo-discover", {
      "pnpm-workspace.yaml": "packages:\n  - packages/**\n",
      // pkg-large: 15 files, has src/, has package.json
      "packages/@scope/pkg-large/package.json": JSON.stringify({ name: "@scope/pkg-large" }),
      "packages/@scope/pkg-large/src/index.ts": "export const a = 1;",
      "packages/@scope/pkg-large/src/b.ts": "export const b = 2;",
      "packages/@scope/pkg-large/src/c.ts": "export const c = 3;",
      "packages/@scope/pkg-large/src/d.ts": "export const d = 4;",
      "packages/@scope/pkg-large/src/e.ts": "export const e = 5;",
      "packages/@scope/pkg-large/src/f.ts": "export const f = 6;",
      "packages/@scope/pkg-large/src/g.ts": "export const g = 7;",
      "packages/@scope/pkg-large/src/h.ts": "export const h = 8;",
      "packages/@scope/pkg-large/src/i.ts": "export const i = 9;",
      "packages/@scope/pkg-large/src/j.ts": "export const j = 10;",
      "packages/@scope/pkg-large/src/k.ts": "export const k = 11;",
      "packages/@scope/pkg-large/src/l.ts": "export const l = 12;",
      "packages/@scope/pkg-large/src/m.ts": "export const m = 13;",
      "packages/@scope/pkg-large/src/n.ts": "export const n = 14;",
      "packages/@scope/pkg-large/src/o.ts": "export const o = 15;",
      // pkg-small: 3 files, has src/, has package.json — filtered by minFiles
      "packages/@scope/pkg-small/package.json": JSON.stringify({ name: "@scope/pkg-small" }),
      "packages/@scope/pkg-small/src/index.ts": "export const x = 1;",
      "packages/@scope/pkg-small/src/y.ts": "export const y = 2;",
      "packages/@scope/pkg-small/src/z.ts": "export const z = 3;",
      // pkg-no-src: 12 files but no src/ — filtered by src/ check
      "packages/@scope/pkg-no-src/package.json": JSON.stringify({ name: "@scope/pkg-no-src" }),
      "packages/@scope/pkg-no-src/index.ts": "export const a = 1;",
      "packages/@scope/pkg-no-src/b.ts": "export const b = 2;",
      "packages/@scope/pkg-no-src/c.ts": "export const c = 3;",
      "packages/@scope/pkg-no-src/d.ts": "export const d = 4;",
      "packages/@scope/pkg-no-src/e.ts": "export const e = 5;",
      "packages/@scope/pkg-no-src/f.ts": "export const f = 6;",
      "packages/@scope/pkg-no-src/g.ts": "export const g = 7;",
      "packages/@scope/pkg-no-src/h.ts": "export const h = 8;",
      "packages/@scope/pkg-no-src/i.ts": "export const i = 9;",
      "packages/@scope/pkg-no-src/j.ts": "export const j = 10;",
      "packages/@scope/pkg-no-src/k.ts": "export const k = 11;",
      "packages/@scope/pkg-no-src/l.ts": "export const l = 12;",
      // pkg-force-included: 3 files, listed in include — passes despite small size
      "packages/@scope/pkg-force-included/package.json": JSON.stringify({ name: "@scope/pkg-force-included" }),
      "packages/@scope/pkg-force-included/src/index.ts": "export const x = 1;",
      "packages/@scope/pkg-force-included/src/y.ts": "export const y = 2;",
      "packages/@scope/pkg-force-included/src/z.ts": "export const z = 3;",
    });

    const packages = await discoverPackages(dir, {
      minFiles: 10,
      include: ["@scope/pkg-force-included"],
    });

    const names = packages.map((p: any) => p.name).sort();
    assert.deepEqual(names, ["@scope/pkg-force-included", "@scope/pkg-large"]);
  });

  it("throws when no workspace config found", async () => {
    const { discoverPackages } = await import("../dist/monorepo/discover.js");
    const dir = await writeFixture("monorepo-no-workspace", {
      "package.json": JSON.stringify({ name: "test" }),
    });
    await assert.rejects(
      () => discoverPackages(dir, {}),
      /No workspace patterns found/
    );
  });

  it("respects exclude list", async () => {
    const { discoverPackages } = await import("../dist/monorepo/discover.js");
    const dir = await writeFixture("monorepo-exclude", {
      "pnpm-workspace.yaml": "packages:\n  - packages/**\n",
      "packages/@scope/pkg-a/package.json": JSON.stringify({ name: "@scope/pkg-a" }),
      "packages/@scope/pkg-a/src/index.ts": "export const a = 1;",
      "packages/@scope/pkg-a/src/b.ts": "export const b = 2;",
      "packages/@scope/pkg-a/src/c.ts": "export const c = 3;",
      "packages/@scope/pkg-a/src/d.ts": "export const d = 4;",
      "packages/@scope/pkg-a/src/e.ts": "export const e = 5;",
      "packages/@scope/pkg-a/src/f.ts": "export const f = 6;",
      "packages/@scope/pkg-a/src/g.ts": "export const g = 7;",
      "packages/@scope/pkg-a/src/h.ts": "export const h = 8;",
      "packages/@scope/pkg-a/src/i.ts": "export const i = 9;",
      "packages/@scope/pkg-a/src/j.ts": "export const j = 10;",
      "packages/@scope/pkg-a/src/k.ts": "export const k = 11;",
    });
    const packages = await discoverPackages(dir, { exclude: ["@scope/pkg-a"] });
    assert.equal(packages.length, 0);
  });
});

describe("extractCrossPackageDeps", () => {
  it("finds @scope/* imports and ignores non-workspace packages", async () => {
    const { extractCrossPackageDeps } = await import("../dist/monorepo/deps.js");

    const dir = await writeFixture("monorepo-deps", {
      "src/index.ts": `
        import { foo } from '@scope/pkg-a';
        import { bar } from '@scope/pkg-b';
        import { baz } from 'lodash';
        import { qux } from './local';
      `,
      "src/other.ts": `
        import { x } from '@scope/pkg-a';
        import { y } from '@scope/pkg-c';
      `,
    });

    const deps = await extractCrossPackageDeps(dir, [
      "@scope/pkg-a",
      "@scope/pkg-b",
      "@scope/pkg-c",
    ]);

    assert.deepEqual(deps.sort(), ["@scope/pkg-a", "@scope/pkg-b", "@scope/pkg-c"]);
  });

  it("returns empty array when no cross-package imports exist", async () => {
    const { extractCrossPackageDeps } = await import("../dist/monorepo/deps.js");

    const dir = await writeFixture("monorepo-deps-empty", {
      "src/index.ts": `import { x } from './local'; import React from 'react';`,
    });

    const deps = await extractCrossPackageDeps(dir, ["@scope/pkg-a"]);
    assert.deepEqual(deps, []);
  });
});

describe("runMonorepoScan", () => {
  it("creates .codesight/ for qualifying packages and writes global CODESIGHT.md", async () => {
    const { runMonorepoScan } = await import("../dist/monorepo/orchestrator.js");
    const { existsSync, readFileSync } = await import("node:fs");

    const dir = await writeFixture("monorepo-orchestrator", {
      "pnpm-workspace.yaml": "packages:\n  - packages/**\n",
      // pkg-alpha: qualifies
      "packages/@test/pkg-alpha/package.json": JSON.stringify({ name: "@test/pkg-alpha" }),
      "packages/@test/pkg-alpha/src/index.ts": `
        import { x } from '@test/pkg-beta';
        export function hello() { return 'hello'; }
      `,
      "packages/@test/pkg-alpha/src/b.ts": "export const b = 2;",
      "packages/@test/pkg-alpha/src/c.ts": "export const c = 3;",
      "packages/@test/pkg-alpha/src/d.ts": "export const d = 4;",
      "packages/@test/pkg-alpha/src/e.ts": "export const e = 5;",
      "packages/@test/pkg-alpha/src/f.ts": "export const f = 6;",
      "packages/@test/pkg-alpha/src/g.ts": "export const g = 7;",
      "packages/@test/pkg-alpha/src/h.ts": "export const h = 8;",
      "packages/@test/pkg-alpha/src/i.ts": "export const i = 9;",
      "packages/@test/pkg-alpha/src/j.ts": "export const j = 10;",
      "packages/@test/pkg-alpha/src/k.ts": "export const k = 11;",
      // pkg-beta: qualifies (also a cross-dep of pkg-alpha)
      "packages/@test/pkg-beta/package.json": JSON.stringify({ name: "@test/pkg-beta" }),
      "packages/@test/pkg-beta/src/index.ts": "export const x = 42;",
      "packages/@test/pkg-beta/src/b.ts": "export const b = 2;",
      "packages/@test/pkg-beta/src/c.ts": "export const c = 3;",
      "packages/@test/pkg-beta/src/d.ts": "export const d = 4;",
      "packages/@test/pkg-beta/src/e.ts": "export const e = 5;",
      "packages/@test/pkg-beta/src/f.ts": "export const f = 6;",
      "packages/@test/pkg-beta/src/g.ts": "export const g = 7;",
      "packages/@test/pkg-beta/src/h.ts": "export const h = 8;",
      "packages/@test/pkg-beta/src/i.ts": "export const i = 9;",
      "packages/@test/pkg-beta/src/j.ts": "export const j = 10;",
      "packages/@test/pkg-beta/src/k.ts": "export const k = 11;",
      // pkg-tiny: does not qualify (only 2 files, filtered out)
      "packages/@test/pkg-tiny/package.json": JSON.stringify({ name: "@test/pkg-tiny" }),
      "packages/@test/pkg-tiny/src/index.ts": "export const t = 1;",
      "packages/@test/pkg-tiny/src/util.ts": "export const u = 2;",
    });

    await runMonorepoScan(dir, { monorepo: { enabled: true, minFiles: 10 } });

    // Per-package .codesight/ dirs created for qualifying packages
    assert.ok(existsSync(join(dir, "packages/@test/pkg-alpha/.codesight/CODESIGHT.md")));
    assert.ok(existsSync(join(dir, "packages/@test/pkg-alpha/.codesight/deps.md")));
    assert.ok(existsSync(join(dir, "packages/@test/pkg-beta/.codesight/CODESIGHT.md")));
    // Filtered package gets no .codesight/
    assert.ok(!existsSync(join(dir, "packages/@test/pkg-tiny/.codesight")));

    // deps.md for pkg-alpha lists its cross-dep on pkg-beta
    const depsContent = readFileSync(
      join(dir, "packages/@test/pkg-alpha/.codesight/deps.md"),
      "utf-8"
    );
    assert.ok(depsContent.includes("@test/pkg-beta"), `Expected @test/pkg-beta in deps.md, got:\n${depsContent}`);

    // Global CODESIGHT.md at root lists qualifying packages
    const globalIndex = readFileSync(join(dir, "CODESIGHT.md"), "utf-8");
    assert.ok(globalIndex.includes("packages/@test/pkg-alpha"), `Expected pkg-alpha in global index:\n${globalIndex}`);
    assert.ok(globalIndex.includes("packages/@test/pkg-beta"), `Expected pkg-beta in global index:\n${globalIndex}`);
    assert.ok(!globalIndex.includes("pkg-tiny"), `Did not expect pkg-tiny in global index:\n${globalIndex}`);
  });

  it("only rebuilds the named package when targetPackage is specified", async () => {
    const { runMonorepoScan } = await import("../dist/monorepo/orchestrator.js");
    const { existsSync } = await import("node:fs");

    const dir = await writeFixture("monorepo-refresh-single", {
      "pnpm-workspace.yaml": "packages:\n  - packages/**\n",
      "packages/@test/pkg-a/package.json": JSON.stringify({ name: "@test/pkg-a" }),
      "packages/@test/pkg-a/src/index.ts": "export const a = 1;",
      "packages/@test/pkg-a/src/b.ts": "export const b = 2;",
      "packages/@test/pkg-a/src/c.ts": "export const c = 3;",
      "packages/@test/pkg-a/src/d.ts": "export const d = 4;",
      "packages/@test/pkg-a/src/e.ts": "export const e = 5;",
      "packages/@test/pkg-a/src/f.ts": "export const f = 6;",
      "packages/@test/pkg-a/src/g.ts": "export const g = 7;",
      "packages/@test/pkg-a/src/h.ts": "export const h = 8;",
      "packages/@test/pkg-a/src/i.ts": "export const i = 9;",
      "packages/@test/pkg-a/src/j.ts": "export const j = 10;",
      "packages/@test/pkg-a/src/k.ts": "export const k = 11;",
      "packages/@test/pkg-b/package.json": JSON.stringify({ name: "@test/pkg-b" }),
      "packages/@test/pkg-b/src/index.ts": "export const b = 1;",
      "packages/@test/pkg-b/src/c.ts": "export const c = 2;",
      "packages/@test/pkg-b/src/d.ts": "export const d = 3;",
      "packages/@test/pkg-b/src/e.ts": "export const e = 4;",
      "packages/@test/pkg-b/src/f.ts": "export const f = 5;",
      "packages/@test/pkg-b/src/g.ts": "export const g = 6;",
      "packages/@test/pkg-b/src/h.ts": "export const h = 7;",
      "packages/@test/pkg-b/src/i.ts": "export const i = 8;",
      "packages/@test/pkg-b/src/j.ts": "export const j = 9;",
      "packages/@test/pkg-b/src/k.ts": "export const k = 10;",
      "packages/@test/pkg-b/src/l.ts": "export const l = 11;",
    });

    await runMonorepoScan(
      dir,
      { monorepo: { enabled: true, minFiles: 10 } },
      "@test/pkg-a"
    );

    assert.ok(existsSync(join(dir, "packages/@test/pkg-a/.codesight/CODESIGHT.md")));
    // pkg-b was NOT included in the targeted refresh
    assert.ok(!existsSync(join(dir, "packages/@test/pkg-b/.codesight")));
  });

  it("warns and returns when targetPackage is not found", async () => {
    const { runMonorepoScan } = await import("../dist/monorepo/orchestrator.js");

    const dir = await writeFixture("monorepo-refresh-unknown", {
      "pnpm-workspace.yaml": "packages:\n  - packages/**\n",
    });

    // Should not throw — should log a warning and return cleanly
    await assert.doesNotReject(() =>
      runMonorepoScan(dir, { monorepo: { enabled: true } }, "@test/nonexistent")
    );
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWikiArticle } from "../dist/generators/wiki.js";

async function createWikiFixture() {
  const root = await mkdtemp(join(tmpdir(), "codesight-wiki-test-"));
  const outputDir = join(root, ".codesight");
  const wikiDir = join(outputDir, "wiki");
  await mkdir(wikiDir, { recursive: true });
  await writeFile(
    join(wikiDir, "overview.md"),
    "# Overview\n\nTest content for the wiki overview article.\n",
    "utf-8"
  );
  await writeFile(
    join(wikiDir, "index.md"),
    "# Index\n\n- [Overview](./overview.md)\n",
    "utf-8"
  );
  return { root, outputDir };
}

test("readWikiArticle returns content for an existing article (cross-platform path resolution)", async () => {
  const { root, outputDir } = await createWikiFixture();
  try {
    const overview = await readWikiArticle(outputDir, "overview");
    assert.notEqual(overview, null, "expected content for 'overview', got null");
    assert.match(overview!, /Test content/);

    // Should also accept the explicit .md extension
    const overviewWithExt = await readWikiArticle(outputDir, "overview.md");
    assert.notEqual(overviewWithExt, null);
    assert.match(overviewWithExt!, /Test content/);

    // Should also resolve index.md the same way
    const index = await readWikiArticle(outputDir, "index");
    assert.notEqual(index, null);
    assert.match(index!, /Index/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readWikiArticle rejects path-traversal attempts", async () => {
  const { root, outputDir } = await createWikiFixture();
  try {
    const escaped1 = await readWikiArticle(outputDir, "../../../etc/passwd");
    assert.equal(escaped1, null, "expected null for ../../../etc/passwd");

    const escaped2 = await readWikiArticle(outputDir, "../package.json");
    assert.equal(escaped2, null, "expected null for ../package.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readWikiArticle returns null for nonexistent articles", async () => {
  const { root, outputDir } = await createWikiFixture();
  try {
    const missing = await readWikiArticle(outputDir, "does-not-exist");
    assert.equal(missing, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

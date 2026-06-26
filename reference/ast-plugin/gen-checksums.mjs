// Regenerates checksums.json with the sha256 of the reference plugin's source,
// built wasm, and manifest. Run after changing the plugin:
//
//   pnpm build:reference && pnpm checksums:reference
//
// CI rebuilds the wasm and compares these committed hashes against the freshly
// built files (see .github/workflows/wasm-plugin-abi.yml), which catches both
// a stale committed binary and any file edited without regenerating hashes.
//
// Dependency-free (node:crypto); hex sha256 matches `shasum -a 256` / `sha256sum`.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const FILES = [
  "assembly/index.ts",
  "codesight-reference-ast.wasm",
];

const files = {};
for (const rel of FILES) {
  files[rel] = createHash("sha256").update(readFileSync(join(DIR, rel))).digest("hex");
}

const out = { algorithm: "sha256", files };
writeFileSync(join(DIR, "checksums.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote checksums.json:");
for (const [f, h] of Object.entries(files)) console.log(`  ${h}  ${f}`);

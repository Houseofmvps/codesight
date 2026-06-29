# Reference AST plugin (ABI conformance fixture)

A minimal, dependency-free WebAssembly plugin used to exercise the codesight
native-AST plugin ABI end-to-end and catch drift between the implementation and
the contract in [`docs/wasm-plugins.md`](../../docs/wasm-plugins.md).

**This is not shipped** — `reference/` is outside `package.json`'s `files`
allowlist, so it is excluded from the published npm package.

**This is not the TypeScript in `src/`.** It's written in
[AssemblyScript](https://www.assemblyscript.org/) (a TypeScript-like dialect with
WASM-native types) and compiled to wasm by `asc`. It is **not a real parser** — it
scans the input for marker lines and emits the corresponding contract shapes:

| Marker line              | Kind      | Emits                                                       |
|--------------------------|-----------|-------------------------------------------------------------|
| `route <METHOD> <path>`  | `routes`  | `{ "method", "path" }`                                      |
| `model <Name> [field …]` | `schemas` | `{ "name", "fields":[…], "relations":[], "orm":"unknown" }` |
| `import <target>`        | `imports` | `"<target>"`                                                |

Anything else is ignored; input with no markers yields nothing (the host then
falls back to its built-in extractors).

It also exports `describe()`, reporting `{ "languageId": "reference",
"extensions": [".ref"] }`, so the host's metadata-driven discovery and
language-routing path is exercised alongside the `parse*` kinds.

For a realistic, language-parsing example, see the ABI doc — the reference plugin
intentionally stays minimal.

## ⚠️ Do not copy this as a starting point for a real plugin

This fixture optimizes for *minimal size*, not correctness-under-load. In
particular it is built with AssemblyScript's **`--runtime stub`**, where
`heap.free` is a **no-op** — so the `dealloc` export does nothing and every
allocation leaks. That is harmless here (the conformance test calls `parse` a
handful of times in a short-lived process), but a real plugin is invoked **once
per source file across an entire repository**, so the same pattern would grow
linear memory without bound during a single scan.

If you build a production plugin:
- Use a runtime with a real allocator (e.g. AssemblyScript `--runtime incremental`
  or `minimal`, or a manual allocator in Rust/Zig/etc.) so `dealloc` actually
  frees, matching the ABI's ownership contract.
- Do real parsing (this plugin only scans comment markers — it is **not** a
  parser and intentionally does not pull in `syn`, a JS engine, or any AST
  library).
- Treat this file only as an ABI/wiring reference, not a code template.

## Build

```bash
pnpm build:reference        # asc --config reference/ast-plugin/asconfig.json
```

Produces `codesight-reference-ast.wasm` (~4 KB) in this directory. A prebuilt copy
is committed for convenience; CI rebuilds it from source and runs the conformance
test against the fresh build so any drift fails before merge.

## Test

```bash
pnpm build                                          # compile the host (dist/)
pnpm exec tsx --test tests/reference-plugin.test.ts # run against the committed wasm
```

The test resolves the wasm from `CODESIGHT_REFERENCE_PLUGIN_DIR` if set, else this
directory.

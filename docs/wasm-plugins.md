# Native-AST WASM Plugins — Contract Reference

`codesight` implements support for optional, user-supplied WebAssembly plugins
that can provide AST-grade route/schema/import extraction. Currently, codesight
does not ship any language-specific plugins itself; it exclusively includes support
for parsing user-specified languages via user-supplied plugins. When no plugin is
present (the default), `codesight` uses its built-in extractors and behaves exactly
as it otherwise would.

This document is the contract a plugin must satisfy. It covers:

- [Mental model](#mental-model)
- [Discovery & naming](#discovery--naming)
- [Enabling native parsing](#enabling-native-parsing)
- [The WASM ABI](#the-wasm-abi)
- [Extraction kinds](#extraction-kinds)
- [JSON output shapes](#json-output-shapes)
- [Fallback & strict semantics](#fallback--strict-semantics)
- [Plugin skeleton](#plugin-skeleton)
- [Building & testing locally](#building--testing-locally)
- [Releases](#releases)
- [Versioning](#versioning)

---

## Mental model

For each source file, `codesight` calls the matching per-kind export
(`parseRoutes` / `parseSchemas`) with the file's source. You return a UTF8-encoded
JSON array describing what you found. `codesight` maps that JSON into its domain
types, **stamps the contextual fields it already knows** (file path, the
source/framework label it associated with the file, route tags), tags the result
`confidence: "native"`, and merges it into the scan.

You provide only the *intrinsic* parse result. `codesight` injects context. Any
contextual fields you emit (`file`, `framework`, `tags`, `from`, `confidence`) are
**ignored** — while you are free to compute them, `codesight` *will* ignore them.

The module is instantiated once per scan and its `parse*` functions are called many
times (it's a long-lived "reactor", not a per-file process). Compile a library, not
a command.

> **Scope:** `codesight` ships no parsers itself. Dispatch is **language-driven**: a
> plugin declares the file extensions it handles (via `describe()`, below), and
> `codesight` routes matching files to it — so *any* language works, not just the ones
> with built-in extractors. Where no plugin handles a file, built-in extraction stands.

---

## Discovery & naming

Plugin binaries must match the template (anything else on the path is ignored):

```
codesight-<lang>-ast.wasm            # `<lang>` ∈ [a-z0-9_-]+ ; the `-ast` capability namespace is reserved
```

The module is **fully self-describing** — no sidecar manifest. Its `describe()`
export (below) declares the authoritative `languageId` and the file `extensions`
it parses; the `<lang>` in the filename is only a discovery key + fallback id (if
`describe().languageId` is set and differs, the declared id wins, with a warning).
For the built-in language ids (`rust`/`go`/`python`) a default extension map
(`.rs`/`.go`/`.py`) applies when `describe()` is omitted; **any other language must
declare `extensions`** or it can't be routed.

Directories are searched in PATH-style waterfall order:

1. `--plugin-dir <dir>` / `CODESIGHT_PLUGIN_DIR` (relative paths resolve against the project root)
2. `~/.codesight/plugins`
3. `${XDG_DATA_HOME:-~/.local/share}/codesight/plugins`
4. `<codesight install dir>/plugins`

**Precedence:** per language id, the first dir wins (lower dirs shadowed). If two
*different* languages claim the same extension, an explicitly-named language beats
an `all`-discovered one, else first-registered wins — with a warning either way.

---

## Enabling native parsing

Native parsing is off unless explicitly enabled. Precedence is `CLI` > `env` > `config file`.

| Mechanism | Example                                                                                                                            |
|-----------|------------------------------------------------------------------------------------------------------------------------------------|
| CLI       | `codesight --native-ast` (= all) · `codesight --native-ast=rust,go` · `codesight --native-ast=none` · `codesight --native-ast-strict` · `codesight --plugin-dir ./wasm` |
| Env       | `CODESIGHT_NATIVE_AST=all` (or `1`/`true`/`strict`/`none`, or a comma list of ids) · `CODESIGHT_PLUGIN_DIR=/path`                  |
| Config    | `codesight.config.{json,js,ts}` → `{ "nativeAst": { "enabled": true, "languages": ["rust"], "pluginDir": "./wasm" } }`             |

`enabled` may be `true`, `false`, or `"strict"`. `none` forces off (overriding the
config file). **Dispatch mode depends on how you enable it:**

- **`all` / bare flag / empty `languages`** → *additive*: every discovered plugin is
  consulted, and results are **unioned** with the built-in extractors (native wins on
  a `method:path` / model-name conflict).
- **An explicit language list** (`--native-ast=rust,go`) → *authoritative*: for files
  a named plugin handles, its results **replace** the built-in routes from that file
  (dropping regex over-matches). If the plugin returns nothing for a file the built-in
  did extract, the built-in stands and a warning is emitted. (Authoritative replacement
  is route-only — `SchemaModel` carries no file provenance, so schemas are always
  native-preferred dedup-by-name.)

---

## The WASM ABI

The host instantiates every module with a **minimal WASI import object** (Node's
built-in `node:wasi` — clock/random/exit/stderr only; **no filesystem, no network,
no env/args**). Pure-compute modules (Rust/AssemblyScript, no imports) ignore it;
modules whose runtime needs WASI (e.g. Go `//go:wasmexport` reactors) get exactly
those minimal capabilities. A reactor that exports `_initialize` is initialized
before its other exports are called. "Plugins are pure compute" — if a kind ever
needs project context, it flows through the ABI, not the filesystem.

A conforming module exports a small fixed core plus optional capability functions:

| Export            | Signature (wasm types)                | Purpose                                         |
|-------------------|---------------------------------------|-------------------------------------------------|
| `memory`          | linear memory                         | the module's exported memory                    |
| `alloc`           | `(len: i32) -> i32`                   | reserve `len` bytes, return a pointer           |
| `dealloc`         | `(ptr: i32, len: i32) -> ()`          | release a prior allocation                      |
| `contractVersion` | `() -> i32`                           | the contract version this plugin implements     |
| `describe`        | `() -> i64`                           | *optional* — packed JSON metadata (see below)   |
| `parseRoutes`     | `(srcPtr: i32, srcLen: i32) -> i64`   | *optional* — extract routes                     |
| `parseSchemas`    | `(srcPtr: i32, srcLen: i32) -> i64`   | *optional* — extract schema models              |
| `parseImports`    | `(srcPtr: i32, srcLen: i32) -> i64`   | *optional* — extract imports (defined, not yet dispatched — see below) |

The host **rejects** a module that lacks `memory`/`alloc`/`dealloc`/`contractVersion`,
or whose `contractVersion()` does not equal the host's (currently **1**) — that
also makes `contractVersion` a "this is a codesight plugin" marker. **Capability is
detected by export presence:** a plugin supports a kind iff it exports the matching
`parse*` function. There are no kind codes and no manifest.

### `describe()` — self-description

Optional. Returns packed `(outPtr << 32) | outLen` pointing at UTF-8 JSON (same
convention as `parse*`), e.g.:

```jsonc
{ "languageId": "ruby", "extensions": [".rb", ".rake"] }
```

The host reads `languageId` (authoritative over the filename) and `extensions` (how
files are routed to this plugin); other fields are carried but unused for now. A
plugin for a non-built-in language **must** declare `extensions` here, or it has no
files to receive.

As WebAssembly text:

```wat
(memory (export "memory") 1)
(func (export "alloc")           (param i32)      (result i32) ...)
(func (export "dealloc")         (param i32 i32)               ...)
(func (export "contractVersion")                  (result i32) ...)
(func (export "parseRoutes")     (param i32 i32)  (result i64) ...)
(func (export "parseSchemas")    (param i32 i32)  (result i64) ...)
```

### Calling convention

For one `parse<Kind>` call `codesight` does:

1. `ptr = alloc(srcLen)` and writes the UTF-8 source bytes at `ptr`.
2. `packed = parseRoutes(ptr, srcLen)` (or `parseSchemas`/`parseImports`).
3. `dealloc(ptr, srcLen)` — **`codesight` frees the input.** Your function must not
   free it, and must not return a pointer *into* it.
4. Unpacks `packed` (see below). If `outLen == 0`, the result is "nothing" → stop.
5. Reads `outLen` UTF-8 bytes at `outPtr` and parses them as JSON.
6. `dealloc(outPtr, outLen)` — **`codesight` frees your output.** It must stay valid
   until this call.

`alloc`/`dealloc` are used by the host for **both** directions, so input and output
must come from the same allocator your `dealloc` can release.

### The packed return value

Each `parse<Kind>` returns a 64-bit value encoding an output pointer and length:

```
packed = (outPtr << 32) | outLen      // both unsigned 32-bit
```

- `outLen == 0` → "no result for this file/kind"; `codesight` falls back to its
  built-in extractor. Return `0` when you don't handle a kind, or found nothing.
- `outPtr` points at `outLen` bytes of UTF-8 JSON in linear memory.

### Memory growth

You may grow linear memory freely inside `alloc`/`parse*`. `codesight` re-reads the
memory buffer after every call into the module, so detaching the backing buffer
via `memory.grow` is safe.

### Traps

A wasm trap propagates to `codesight` as an error. In `--native-ast-strict` it is
recorded as a per-file diagnostic; in plain `--native-ast` it falls back silently.
Prefer returning `0` over trapping — mirror the built-in extractors, which treat a
syntax error as "found nothing".

---

## Extraction kinds

Each kind is a separate optional export; presence of the export *is* the
capability declaration. A plugin implements only the kinds it handles.

| Kind      | Export         | Returns                                    |
|-----------|----------------|--------------------------------------------|
| `routes`  | `parseRoutes`  | array of [route](#routes) objects          |
| `schemas` | `parseSchemas` | array of [schema model](#schemas) objects  |
| `imports` | `parseImports` | array of [import](#imports) entries        |

> **`imports` is defined but not yet dispatched.** A conforming plugin may export
> `parseImports`, and the host can load and call it — but `codesight` does **not**
> invoke it during a scan yet. Dependency-graph edges must resolve to
> project-relative file paths, which a per-file plugin can't do without
> whole-project context (root, file list, module-resolution rules). The export
> stays in the contract so that wiring it later is purely additive; until then,
> built-in extraction handles imports.

---

## JSON output shapes

All shapes are JSON arrays. Unknown fields are ignored. Fields marked *(host)* are
injected by `codesight` and ignored if you emit them.

### routes

```jsonc
[
  {
    "method": "GET",          // optional; default "ALL". Uppercase verb.
    "path": "/items/{id}",    // the route path
    "params": ["id"],         // optional; if omitted, derived from `path`
                              //   (matches :x, {x}, <x>, <type:x>)
    "middleware": ["auth"]    // optional; names of guards/middleware
  }
]
```

Injected *(host)*: `file`, `tags`, `framework`, `confidence: "native"`. The
`framework` is the source/framework label `codesight` already associated with the
file, so you only report method/path (and optionally params/middleware).

### schemas

```jsonc
[
  {
    "name": "User",
    "fields": [
      { "name": "id",    "type": "integer", "flags": ["pk"] },
      { "name": "email", "type": "string",  "flags": ["unique", "nullable"] }
    ],
    "relations": ["posts: many(Post)", "team: Team"],  // free-form strings
    "orm": "my-orm"            // optional; short source identifier; default "unknown"
  }
]
```

- `fields[].type` defaults to `"unknown"`; `fields[].flags` defaults to `[]`.
- Conventional flags: `pk`, `fk`, `unique`, `nullable`, `default`, `index`, `required`.
- `relations` is an array of display strings — `codesight` does not parse them.
- `orm` is a short identifier string for the model's source. Identifiers codesight
  recognizes get source-specific rendering; any other string is accepted and shown
  as-is.

Injected *(host)*: `confidence: "native"`.

### imports

```jsonc
["./db", "./models/user"]
```

or, equivalently:

```jsonc
[{ "to": "./db" }, { "to": "./models/user" }]
```

Each entry is the import target. Injected *(host)*: `from` (the file being
analyzed). Note `parseImports` is **defined but not dispatched** (see
[Extraction kinds](#extraction-kinds)); when it is wired, `to` will need to be a
**project-relative file path** for the dependency graph to resolve it.

---

## Fallback & strict semantics

For a given file and kind, `codesight` uses the **first** of:

1. **Native plugin** — if enabled for the language identifier, present, exports the
   matching `parse*`, and that function returns a non-empty array.
2. **Built-in extractor** — `codesight`'s existing extraction for that file.

| Situation                                   | Plain `--native-ast` | `--native-ast-strict`                                 |
|---------------------------------------------|----------------------|-------------------------------------------------------|
| Plugin enabled but no `.wasm` found / incompatible `contractVersion` | silent fallback | one diagnostic per `(lang, kind)`, run exits non-zero |
| `parse*` returns `0` / empty array          | silent fallback      | silent fallback (empty is normal, not an error)       |
| `parse*` traps                              | silent fallback      | per-file diagnostic, run exits non-zero               |

Strict mode never degrades output (it always falls back so results are never worse)
and never aborts mid-scan — it collects diagnostics, prints them at the end, and
sets a non-zero exit code so CI can assert the plugin actually ran.

Results from a plugin are tagged `confidence: "native"` and reported separately
from built-in `ast`/`regex` results in the scan summary.

---

## Plugin skeleton

Implement the module in any toolchain that targets `wasm32` and imports **at most
`wasi_snapshot_preview1`** (no JS-binding glue, no other host functions). Pure-compute
languages (Rust/AssemblyScript via `wasm32-unknown-unknown`) need no imports at all;
full-runtime languages (Go via `GOOS=wasip1 -buildmode=c-shared` + `//go:wasmexport`)
import WASI, which the host supplies minimally. The allocator and per-kind marshalling
are boilerplate; only your extraction logic changes. Export `describe()` (for routing)
plus the `parse*` functions for the kinds you support.

Required exports and their behavior, in pseudocode:

```
export contractVersion() -> i32:
    return 1                                    # must match the host

export alloc(len) -> ptr:
    return pointer to `len` freshly reserved bytes (from a global allocator)

export dealloc(ptr, len):
    free the allocation at `ptr` of size `len`

# one of these per supported kind — presence is the capability declaration
export parseRoutes(srcPtr, srcLen) -> i64:  return emit(extract_routes(read(srcPtr, srcLen)))
export parseSchemas(srcPtr, srcLen) -> i64: return emit(extract_schemas(read(srcPtr, srcLen)))

read(ptr, len):
    return utf8_string(memory[ptr .. ptr + len])    # host owns this buffer

emit(json) -> i64:
    if json is empty or "[]": return 0          # nothing -> host falls back
    out = alloc(byte_length(json))              # a fresh, host-owned buffer
    copy json bytes into memory at `out`
    return (out << 32) | byte_length(json)      # host reads JSON, then deallocs `out`
```

Notes:

- Use one allocator for both directions so the host's `dealloc(outPtr, outLen)`
  releases exactly what `alloc` reserved (size and alignment must match).
- Do not free or alias the input buffer — the host frees it after the call returns.
- Return `0` (not a trap) for parse failures.

---

## Building & testing locally

```bash
# Place your built module on the search path, named for your language identifier.
# It is fully self-describing (version + capabilities via exports) — no manifest.
mkdir -p ~/.codesight/plugins
cp path/to/your-module.wasm ~/.codesight/plugins/codesight-<lang>-ast.wasm

# Run against a project; strict mode proves the plugin actually ran
codesight --native-ast-strict ./my-project
```

In the scan summary, native results appear as e.g.
`done (native: 12 routes, 3 models | AST: …)`. If strict mode reports
`plugin unavailable`, the `.wasm` wasn't found on the search path or its
`contractVersion()` didn't match; if it reports a per-file reason, a `parse*`
function trapped on that file.

---

## Releases

`codesight`'s npm package ships **no** plugins — but the project maintains a small
set of reference implementations under [`plugins/ast/`](../plugins/ast) and publishes
them as **prebuilt release assets**, so you don't have to set up a Rust/Go toolchain
to use them:

| Asset                        | Language | Parser                                                            |
|------------------------------|----------|-------------------------------------------------------------------|
| `codesight-rust-ast.wasm`    | Rust     | [`syn`](https://docs.rs/syn)                                      |
| `codesight-python-ast.wasm`  | Python   | [`ruff`](https://github.com/astral-sh/ruff) (`ruff_python_ast`)   |
| `codesight-go-ast.wasm`      | Go       | stdlib `go/parser`                                                |

They are optional and opt-in; with none installed, `codesight` behaves exactly as
its built-in extractors always have.

**Built in CI, not in this package.** The [`ast-plugins`](../.github/workflows/ast-plugins.yml)
workflow compiles each plugin from source, smoke-tests it against the host ABI, and
attaches the `.wasm` files plus a `SHA256SUMS` manifest to a GitHub Release. Because
WebAssembly is platform-independent, one artifact per plugin runs on every OS and
architecture — there are no per-platform downloads.

**Independent versioning.** Plugins are released on their own `plugins-v*` tags,
decoupled from `codesight`'s npm version. Compatibility is governed solely by the ABI
[`contractVersion()`](#versioning): any plugin built for the host's contract works,
and one built for an older contract is cleanly skipped.

**Installing a released plugin:**

```bash
mkdir -p ~/.codesight/plugins
cd ~/.codesight/plugins

# Download the asset(s) you want from the GitHub Release — already named to match the
# discovery template (no renaming needed) — plus the checksum manifest.
curl -LO https://github.com/Houseofmvps/codesight/releases/download/<tag>/codesight-rust-ast.wasm
curl -LO https://github.com/Houseofmvps/codesight/releases/download/<tag>/SHA256SUMS

# Verify integrity before trusting the binary.
sha256sum --ignore-missing -c SHA256SUMS

# Enable it (an explicit language list is authoritative for that language's files).
codesight --native-ast=rust ./my-project
```

Dropped into any directory on the [discovery waterfall](#discovery--naming), the
plugin is picked up automatically; `--plugin-dir <dir>` points at an arbitrary
location instead.

---

## Versioning

The current contract version is **1**. Breaking changes to the ABI or JSON shapes
will bump it. Your module reports its version via the `contractVersion()` export,
so a plugin built for an older contract is cleanly skipped (→ built-in fallback) by
a newer host rather than being misinterpreted.

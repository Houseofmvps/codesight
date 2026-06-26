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

> **Scope:** `codesight` invokes a plugin only at its own extraction points and only
> for a language identifier it recognizes. It provides no WASM-based parsers itself.
> Where no plugin is configured, it falls back to its built-in extraction. This contract
> defines the boundary; it does not promise any particular language is wired up.

---

## Discovery & naming

A plugin is identified by a language identifier `<lang>`. Per identifier,
`codesight` looks for a single self-describing module — no sidecar manifest:

```
codesight-<lang>-ast.wasm            # the module (required)
```

The `-ast` segment is the capability namespace (reserved to allow the same plugin
mechanism to host other capabilities later if/when it becomes beneficial or desirable
to do so). The module declares its own contract version and capabilities through
its exports (see below), so there is nothing else to ship or keep in sync.

Directories are searched in this order; the **first** directory containing a
matching `.wasm` binary wins (\*nix `PATH`-style waterfall):

1. `--plugin-dir <dir>` / `CODESIGHT_PLUGIN_DIR` (relative paths resolve against the project root)
2. `~/.codesight/plugins`
3. `${XDG_DATA_HOME:-~/.local/share}/codesight/plugins`
4. `<codesight install dir>/plugins`

---

## Enabling native parsing

Native parsing is off unless explicitly enabled. Precedence is `CLI` > `env` > `config file`.

| Mechanism | Example                                                                                                                         |
|-----------|---------------------------------------------------------------------------------------------------------------------------------|
| CLI       | `codesight --native-ast` · `codesight --native-ast <langs>` · `codesight --native-ast-strict` · `codesight --plugin-dir ./wasm` |
| Env       | `CODESIGHT_NATIVE_AST=1` (or `strict`, or a comma list of language identifiers) · `CODESIGHT_PLUGIN_DIR=/path`                  |
| Config    | `codesight.config.{json,js,ts}` → `{ "nativeAst": { "enabled": true, "languages": ["<lang>"], "pluginDir": "./wasm" } }`        |

`enabled` may be `true`, `false`, or `"strict"`. Omitting `languages` (or passing
an empty list) enables every language identifier `codesight` recognizes; supplying a
list restricts native parsing to those identifiers.

---

## The WASM ABI

There are **no imports** — codesight instantiates with an empty import object, so
the module must not require WASI, JS-binding glue, or any host functions.

A conforming module exports a small fixed core plus one optional `parse*` function
per capability it provides:

| Export            | Signature (wasm types)                | Purpose                                         |
|-------------------|---------------------------------------|-------------------------------------------------|
| `memory`          | linear memory                         | the module's exported memory                    |
| `alloc`           | `(len: i32) -> i32`                   | reserve `len` bytes, return a pointer           |
| `dealloc`         | `(ptr: i32, len: i32) -> ()`          | release a prior allocation                      |
| `contractVersion` | `() -> i32`                           | the contract version this plugin implements     |
| `parseRoutes`     | `(srcPtr: i32, srcLen: i32) -> i64`   | *optional* — extract routes                     |
| `parseSchemas`    | `(srcPtr: i32, srcLen: i32) -> i64`   | *optional* — extract schema models              |
| `parseImports`    | `(srcPtr: i32, srcLen: i32) -> i64`   | *optional* — extract imports (defined, not yet dispatched — see below) |

The host **rejects** a module that lacks `memory`/`alloc`/`dealloc`/`contractVersion`,
or whose `contractVersion()` does not equal the host's (currently **1**) — that
also makes `contractVersion` a "this is a codesight plugin" marker. **Capability is
detected by export presence:** a plugin supports a kind iff it exports the matching
`parse*` function. There are no kind codes and no manifest.

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

Implement the module in any toolchain that compiles to a `wasm32` module with **no
imports** (no WASI, no JS-binding glue). The allocator and the per-kind marshalling
are boilerplate; the only part that changes is your extraction logic. Export only
the `parse*` functions for the kinds you support.

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

## Versioning

The current contract version is **1**. Breaking changes to the ABI or JSON shapes
will bump it. Your module reports its version via the `contractVersion()` export,
so a plugin built for an older contract is cleanly skipped (→ built-in fallback) by
a newer host rather than being misinterpreted.

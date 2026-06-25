// codesight WASM-plugin ABI conformance fixture (AssemblyScript).
//
// NOT the TypeScript in src/ — this is the AssemblyScript dialect (WASM-native
// types, its own stdlib) compiled to wasm by `asc`. It is excluded from the npm
// package (see package.json "files") and is NOT a real parser: it scans the
// input for simple marker lines and emits the corresponding output shapes. Its
// only job is to exercise the host ABI end-to-end and catch contract drift.
//
// Markers (whitespace-delimited, one per line; anything else is ignored):
//   route  <METHOD> <path>          -> { method, path }
//   model  <Name> [field ...]       -> { name, fields[], relations:[], orm:"unknown" }
//   import <target>                  -> "<target>"
//
// `parseImports` is part of the published contract and exercised by the
// conformance test, but codesight does not dispatch to it during a scan yet.
//
// ⚠️ DO NOT COPY THIS AS A REAL-PLUGIN TEMPLATE. It is compiled with
// `--runtime stub`, so `dealloc`/`heap.free` is a no-op and every allocation
// leaks. That is fine for a fixture called a few times in a short-lived test,
// but a real plugin runs once per file across a whole repo and would leak
// unboundedly. A production plugin must use a runtime whose `dealloc` actually
// frees (e.g. AssemblyScript `--runtime incremental`/`minimal`). See README.md.

/** ABI contract version this plugin implements (must match the host's). */
export function contractVersion(): i32 {
  return 1;
}

/** Optional self-description: language id + the extensions this plugin parses. */
export function describe(): i64 {
  return emit("{\"languageId\":\"reference\",\"extensions\":[\".ref\"]}");
}

// ─── ABI: memory management ───

export function alloc(len: i32): i32 {
  return heap.alloc(<usize>len) as i32;
}

export function dealloc(ptr: i32, len: i32): void {
  heap.free(<usize>ptr);
}

// ─── ABI: per-kind parse entry points ───

export function parseRoutes(srcPtr: i32, srcLen: i32): i64 {
  return emit(extractRoutes(decode(srcPtr, srcLen)));
}

export function parseSchemas(srcPtr: i32, srcLen: i32): i64 {
  return emit(extractSchemas(decode(srcPtr, srcLen)));
}

export function parseImports(srcPtr: i32, srcLen: i32): i64 {
  return emit(extractImports(decode(srcPtr, srcLen)));
}

// ─── shared marshalling ───

function decode(srcPtr: i32, srcLen: i32): string {
  return String.UTF8.decodeUnsafe(<usize>srcPtr, <usize>srcLen);
}

// Encode `json` into a fresh host-owned buffer and pack (outPtr << 32) | outLen.
// Returns 0 for empty results so the host falls back to its built-in extractor.
function emit(json: string): i64 {
  if (json.length == 0 || json == "[]") return 0;
  const len = String.UTF8.byteLength(json, false);
  const outPtr = heap.alloc(<usize>len);
  String.UTF8.encodeUnsafe(changetype<usize>(json), json.length, outPtr, false);
  return ((<i64>outPtr) << 32) | (<i64>len);
}

// ─── marker parsing ───

function tokenize(line: string): string[] {
  const parts = line.split(" ");
  const out = new Array<string>();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p.length > 0) out.push(p);
  }
  return out;
}

// Minimal JSON string quoting (markers shouldn't contain quotes/backslashes,
// but escape them anyway so malformed input can't produce invalid JSON).
function quote(s: string): string {
  let r = "\"";
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c == "\"" || c == "\\") r += "\\";
    r += c;
  }
  return r + "\"";
}

function extractRoutes(src: string): string {
  const lines = src.split("\n");
  const items = new Array<string>();
  for (let i = 0; i < lines.length; i++) {
    const t = tokenize(lines[i]);
    if (t.length >= 3 && t[0] == "route") {
      items.push("{\"method\":" + quote(t[1]) + ",\"path\":" + quote(t[2]) + "}");
    }
  }
  return "[" + items.join(",") + "]";
}

function extractSchemas(src: string): string {
  const lines = src.split("\n");
  const items = new Array<string>();
  for (let i = 0; i < lines.length; i++) {
    const t = tokenize(lines[i]);
    if (t.length >= 2 && t[0] == "model") {
      const fields = new Array<string>();
      for (let j = 2; j < t.length; j++) {
        fields.push("{\"name\":" + quote(t[j]) + ",\"type\":\"unknown\",\"flags\":[]}");
      }
      items.push(
        "{\"name\":" + quote(t[1]) +
        ",\"fields\":[" + fields.join(",") + "]" +
        ",\"relations\":[],\"orm\":\"unknown\"}"
      );
    }
  }
  return "[" + items.join(",") + "]";
}

function extractImports(src: string): string {
  const lines = src.split("\n");
  const items = new Array<string>();
  for (let i = 0; i < lines.length; i++) {
    const t = tokenize(lines[i]);
    if (t.length >= 2 && t[0] == "import") {
      items.push(quote(t[1]));
    }
  }
  return "[" + items.join(",") + "]";
}

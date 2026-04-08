import { relative, extname } from "node:path";
import { readFileSafe } from "../scanner.js";
import { extractDartExports } from "../ast/extract-dart.js";
import { extractSwiftExports } from "../ast/extract-swift.js";
import { extractCSharpExports } from "../ast/extract-csharp.js";
import { extractPhpExports } from "../ast/extract-php.js";
import type { LibExport, ExportItem, ProjectInfo } from "../types.js";

const SKIP_DIRS = [
  "/components/",
  "/pages/",
  "/app/",
  "/routes/",
  "/views/",
  "/templates/",
  "/__tests__/",
  "/__mocks__/",
  "/test/",
  "/tests/",
  "/stories/",
];

export async function detectLibs(
  files: string[],
  project: ProjectInfo
): Promise<LibExport[]> {
  const libFiles = files.filter((f) => {
    const ext = extname(f);
    if (![".ts", ".js", ".mjs", ".py", ".go", ".dart", ".swift", ".cs", ".php"].includes(ext)) return false;
    if (f.endsWith(".test.ts") || f.endsWith(".spec.ts")) return false;
    if (f.endsWith(".test.js") || f.endsWith(".spec.js")) return false;
    if (f.endsWith(".d.ts")) return false;
    if (f.endsWith("_test.py") || f.endsWith("_test.go")) return false;
    if (f.endsWith("_test.dart") || f.endsWith(".g.dart")) return false;
    if (f.endsWith("Tests.swift") || f.endsWith("_test.swift")) return false;
    // Skip component/page/route files
    if (f.endsWith(".tsx") || f.endsWith(".jsx")) return false;
    if (SKIP_DIRS.some((d) => f.includes(d))) return false;
    return true;
  });

  const libs: LibExport[] = [];

  for (const file of libFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;

    const rel = relative(project.root, file);
    const ext = extname(file);
    let exports: ExportItem[];

    if (ext === ".py") {
      exports = extractPythonExports(content);
    } else if (ext === ".go") {
      exports = extractGoExports(content);
    } else if (ext === ".dart") {
      exports = extractDartExports(content);
    } else if (ext === ".swift") {
      exports = extractSwiftExports(content);
    } else if (ext === ".cs") {
      exports = extractCSharpExports(content);
    } else if (ext === ".php") {
      exports = extractPhpExports(content);
    } else {
      exports = extractTSExports(content);
    }

    // Only include files with at least one function/class export
    const hasMeaningful = exports.some(
      (e) => e.kind === "function" || e.kind === "class"
    );
    if (hasMeaningful && exports.length > 0) {
      libs.push({ file: rel, exports });
    }
  }

  return libs;
}

function extractTSExports(content: string): ExportItem[] {
  const exports: ExportItem[] = [];

  // export function name(params): returnType
  const fnPattern =
    /export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\n{]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = fnPattern.exec(content)) !== null) {
    const params = compactParams(match[2]);
    const ret = match[3]?.trim() || "void";
    exports.push({
      name: match[1],
      kind: "function",
      signature: `(${params}) => ${ret}`,
    });
  }

  // export const name = (...) => or export const name = function
  const constFnPattern =
    /export\s+const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|(\w+))\s*(?::\s*[^=]+)?\s*=>/g;
  while ((match = constFnPattern.exec(content)) !== null) {
    exports.push({
      name: match[1],
      kind: "function",
    });
  }

  // export class Name
  const classPattern = /export\s+(?:abstract\s+)?class\s+(\w+)/g;
  while ((match = classPattern.exec(content)) !== null) {
    exports.push({ name: match[1], kind: "class" });
  }

  // export interface Name
  const ifacePattern = /export\s+interface\s+(\w+)/g;
  while ((match = ifacePattern.exec(content)) !== null) {
    exports.push({ name: match[1], kind: "interface" });
  }

  // export type Name
  const typePattern = /export\s+type\s+(\w+)/g;
  while ((match = typePattern.exec(content)) !== null) {
    exports.push({ name: match[1], kind: "type" });
  }

  // export enum Name
  const enumPattern = /export\s+(?:const\s+)?enum\s+(\w+)/g;
  while ((match = enumPattern.exec(content)) !== null) {
    exports.push({ name: match[1], kind: "enum" });
  }

  // export const Name (non-function)
  const constPattern = /export\s+const\s+(\w+)\s*(?::\s*([^=\n]+))?\s*=/g;
  while ((match = constPattern.exec(content)) !== null) {
    // Skip if already captured as a function
    if (exports.some((e) => e.name === match![1])) continue;
    const type = match[2]?.trim();
    exports.push({
      name: match[1],
      kind: "const",
      signature: type || undefined,
    });
  }

  return exports;
}

function extractPythonExports(content: string): ExportItem[] {
  const exports: ExportItem[] = [];

  // def function_name(params) -> return_type:
  const fnPattern =
    /^def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^\n:]+))?:/gm;
  let match: RegExpExecArray | null;
  while ((match = fnPattern.exec(content)) !== null) {
    if (match[1].startsWith("_")) continue; // skip private
    const params = compactParams(match[2]);
    const ret = match[3]?.trim() || "";
    exports.push({
      name: match[1],
      kind: "function",
      signature: ret ? `(${params}) -> ${ret}` : `(${params})`,
    });
  }

  // async def
  const asyncFnPattern =
    /^async\s+def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^\n:]+))?:/gm;
  while ((match = asyncFnPattern.exec(content)) !== null) {
    if (match[1].startsWith("_")) continue;
    const params = compactParams(match[2]);
    const ret = match[3]?.trim() || "";
    exports.push({
      name: match[1],
      kind: "function",
      signature: ret ? `(${params}) -> ${ret}` : `(${params})`,
    });
  }

  // class ClassName:
  const classPattern = /^class\s+(\w+)/gm;
  while ((match = classPattern.exec(content)) !== null) {
    if (match[1].startsWith("_")) continue;
    exports.push({ name: match[1], kind: "class" });
  }

  return exports;
}

function extractGoExports(content: string): ExportItem[] {
  const exports: ExportItem[] = [];

  // func FunctionName(params) returnType
  const fnPattern =
    /^func\s+(\w+)\s*\(([^)]*)\)\s*([^\n{]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = fnPattern.exec(content)) !== null) {
    // Go exports start with uppercase
    if (match[1][0] !== match[1][0].toUpperCase()) continue;
    const params = compactParams(match[2]);
    const ret = match[3]?.trim() || "";
    exports.push({
      name: match[1],
      kind: "function",
      signature: `(${params}) ${ret}`.trim(),
    });
  }

  // type StructName struct
  const structPattern = /^type\s+(\w+)\s+struct/gm;
  while ((match = structPattern.exec(content)) !== null) {
    if (match[1][0] !== match[1][0].toUpperCase()) continue;
    exports.push({ name: match[1], kind: "class" });
  }

  // type InterfaceName interface
  const ifacePattern = /^type\s+(\w+)\s+interface/gm;
  while ((match = ifacePattern.exec(content)) !== null) {
    if (match[1][0] !== match[1][0].toUpperCase()) continue;
    exports.push({ name: match[1], kind: "interface" });
  }

  return exports;
}

function compactParams(params: string): string {
  if (!params.trim()) return "";
  // Remove type annotations for compactness, keep param names
  return params
    .split(",")
    .map((p) => {
      const trimmed = p.trim();
      // For destructured params, keep the whole thing compact
      if (trimmed.startsWith("{")) return "{...}";
      // Get just the name
      const name = trimmed.split(/[=:]/)[0].trim();
      return name;
    })
    .filter(Boolean)
    .join(", ");
}

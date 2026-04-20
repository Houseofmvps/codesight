/**
 * BrighterScript (.bs) extraction.
 *
 * BrighterScript is a superset of BrightScript with added language features:
 *   - class X extends Y
 *   - namespace X.Y
 *   - enum X
 *   - interface X
 *   - import "pkg:/source/path/File.brs"
 *   - try/catch
 *   - optional chaining (?.)
 *
 * This extractor handles only BrighterScript-specific constructs; it composes
 * with extract-brightscript for functions/subs/observers/etc. so .bs files
 * get both layers of detection.
 */

import type { ExportItem } from "../types.js";
import { extractBrightScriptFunctions } from "./extract-brightscript.js";

/**
 * Extract import targets from `import "pkg:/..."` statements.
 * BrighterScript imports must be at the top of a file, but we scan the whole
 * file for robustness against unusual layouts.
 */
export function extractBrighterScriptImports(content: string): string[] {
  const out: string[] = [];
  const pattern = /^\s*import\s+["']([^"']+)["']/gim;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Extract BrighterScript-only exports (class, namespace, enum, interface)
 * plus functions/subs via the BrightScript extractor.
 *
 * Access modifiers in BrighterScript are not applied to module-level
 * declarations; every class/namespace/enum/interface is effectively public.
 */
export function extractBrighterScriptExports(content: string): ExportItem[] {
  const exports: ExportItem[] = [];
  const seen = new Set<string>();

  const push = (name: string, kind: ExportItem["kind"], signature?: string): void => {
    const key = `${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    exports.push({ name, kind, signature });
  };

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();

    // class X [extends Y]
    const classMatch = trimmed.match(/^class\s+([A-Za-z_][\w]*)(?:\s+extends\s+([A-Za-z_][\w.]*))?/i);
    if (classMatch) {
      const name = classMatch[1];
      const parent = classMatch[2];
      push(name, "class", parent ? `class ${name} extends ${parent}` : `class ${name}`);
      continue;
    }

    // namespace A.B.C
    const nsMatch = trimmed.match(/^namespace\s+([A-Za-z_][\w.]*)/i);
    if (nsMatch) {
      push(nsMatch[1], "const", `namespace ${nsMatch[1]}`);
      continue;
    }

    // enum X
    const enumMatch = trimmed.match(/^enum\s+([A-Za-z_][\w]*)/i);
    if (enumMatch) {
      push(enumMatch[1], "enum", `enum ${enumMatch[1]}`);
      continue;
    }

    // interface X
    const ifaceMatch = trimmed.match(/^interface\s+([A-Za-z_][\w]*)/i);
    if (ifaceMatch) {
      push(ifaceMatch[1], "interface", `interface ${ifaceMatch[1]}`);
      continue;
    }
  }

  // Fold in BrightScript function/sub exports too — .bs is a superset.
  for (const item of extractBrightScriptFunctions(content)) {
    push(item.name, item.kind, item.signature);
  }

  return exports;
}

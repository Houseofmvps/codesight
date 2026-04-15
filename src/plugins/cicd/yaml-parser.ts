/**
 * Purpose-built YAML parser for CI/CD config files (GitHub Actions, CircleCI).
 *
 * Handles the subset of YAML used in CI configs:
 * - Block mappings (nested to ~7 levels)
 * - Block sequences of scalars and of mappings (steps, jobs)
 * - Mixed scalar/mapping sequences (CircleCI workflow jobs)
 * - Literal block scalars (|) for multi-line shell commands
 * - Flow sequences [a, b, c]
 * - Plain, single-quoted, double-quoted scalars
 * - Comments (full-line and inline)
 * - ${{ }} and << >> expressions as opaque strings
 *
 * Does NOT handle: anchors/aliases, tags, flow mappings {}, merge keys, multi-document.
 */

export function parseYAML(text: string): any {
  const lines = text.split("\n");
  let start = 0;
  // Skip leading document marker
  if (lines[start]?.trim() === "---") start++;
  start = skipEmpty(lines, start);
  if (start >= lines.length) return {};
  const { value } = parseBlock(lines, start, indentOf(lines[start]));
  return value;
}

function parseBlock(
  lines: string[],
  startIdx: number,
  baseIndent: number,
): { value: any; nextIdx: number } {
  const idx = skipEmpty(lines, startIdx);
  if (idx >= lines.length) return { value: {}, nextIdx: idx };
  const trimmed = lines[idx].trimStart();
  if (trimmed.startsWith("- ") || trimmed === "-") {
    return parseSequence(lines, idx, baseIndent);
  }
  return parseMapping(lines, idx, baseIndent);
}

function parseMapping(
  lines: string[],
  startIdx: number,
  baseIndent: number,
): { value: Record<string, any>; nextIdx: number } {
  const obj: Record<string, any> = Object.create(null);
  let i = startIdx;

  while (i < lines.length) {
    const ci = skipEmpty(lines, i);
    if (ci >= lines.length) { i = ci; break; }

    const line = lines[ci];
    const indent = indentOf(line);
    if (indent < baseIndent) { i = ci; break; }
    if (indent > baseIndent) { i = ci + 1; continue; }

    const trimmed = line.trimStart();
    // A dash at this indent means we've entered a sequence — bail
    if (trimmed.startsWith("- ")) { i = ci; break; }

    const colonIdx = findKeyColon(trimmed);
    if (colonIdx === -1) { i = ci + 1; continue; }

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (rawValue === "|" || rawValue === "|-" || rawValue === "|+" ||
        rawValue === ">" || rawValue === ">-" || rawValue === ">+") {
      const fold = rawValue.startsWith(">");
      const { value, nextIdx } = consumeBlockScalar(lines, ci + 1, indent);
      obj[key] = fold ? value.replace(/\n/g, " ").trim() : value;
      i = nextIdx;
    } else if (rawValue) {
      obj[key] = parseInlineValue(rawValue);
      i = ci + 1;
    } else {
      // Empty value — check for nested content
      const nextContent = skipEmpty(lines, ci + 1);
      if (nextContent < lines.length && indentOf(lines[nextContent]) > baseIndent) {
        const nested = parseBlock(lines, nextContent, indentOf(lines[nextContent]));
        obj[key] = nested.value;
        i = nested.nextIdx;
      } else {
        obj[key] = null;
        i = ci + 1;
      }
    }
  }

  return { value: obj, nextIdx: i };
}

function parseSequence(
  lines: string[],
  startIdx: number,
  baseIndent: number,
): { value: any[]; nextIdx: number } {
  const arr: any[] = [];
  let i = startIdx;

  while (i < lines.length) {
    const ci = skipEmpty(lines, i);
    if (ci >= lines.length) { i = ci; break; }

    const line = lines[ci];
    const indent = indentOf(line);
    if (indent < baseIndent) { i = ci; break; }
    if (indent > baseIndent) { i = ci + 1; continue; }

    const trimmed = line.trimStart();
    if (!trimmed.startsWith("- ") && trimmed !== "-") { i = ci; break; }

    // Content after "- "
    const afterDash = trimmed === "-" ? "" : trimmed.slice(2);
    const itemIndent = indent + 2; // sibling keys align here

    if (!afterDash.trim()) {
      // Bare dash with nested content below
      const nextContent = skipEmpty(lines, ci + 1);
      if (nextContent < lines.length && indentOf(lines[nextContent]) >= itemIndent) {
        const nested = parseBlock(lines, nextContent, indentOf(lines[nextContent]));
        arr.push(nested.value);
        i = nested.nextIdx;
      } else {
        arr.push(null);
        i = ci + 1;
      }
    } else {
      const colonIdx = findKeyColon(afterDash);
      if (colonIdx !== -1) {
        // Dash item starts an object: "- key: value"
        const key = afterDash.slice(0, colonIdx).trim();
        const rawVal = afterDash.slice(colonIdx + 1).trim();

        const itemObj: Record<string, any> = {};

        // Parse the inline key's value
        if (rawVal === "|" || rawVal === "|-" || rawVal === "|+" ||
            rawVal === ">" || rawVal === ">-" || rawVal === ">+") {
          const fold = rawVal.startsWith(">");
          const { value, nextIdx } = consumeBlockScalar(lines, ci + 1, indent);
          itemObj[key] = fold ? value.replace(/\n/g, " ").trim() : value;
          i = nextIdx;
        } else if (rawVal) {
          itemObj[key] = parseInlineValue(rawVal);
          i = ci + 1;
        } else {
          // Empty inline value — might have nested content
          const nextContent = skipEmpty(lines, ci + 1);
          if (nextContent < lines.length && indentOf(lines[nextContent]) >= itemIndent) {
            const nested = parseBlock(lines, nextContent, indentOf(lines[nextContent]));
            itemObj[key] = nested.value;
            i = nested.nextIdx;
          } else {
            itemObj[key] = null;
            i = ci + 1;
          }
        }

        // Gather sibling keys at itemIndent
        while (i < lines.length) {
          const si = skipEmpty(lines, i);
          if (si >= lines.length) { i = si; break; }
          const sLine = lines[si];
          const sIndent = indentOf(sLine);
          if (sIndent < itemIndent) break;
          if (sIndent > itemIndent) { i = si + 1; continue; }

          const sTrimmed = sLine.trimStart();
          if (sTrimmed.startsWith("- ")) break; // next sequence item

          const sColon = findKeyColon(sTrimmed);
          if (sColon === -1) { i = si + 1; continue; }

          const sKey = sTrimmed.slice(0, sColon).trim();
          const sRaw = sTrimmed.slice(sColon + 1).trim();

          if (sRaw === "|" || sRaw === "|-" || sRaw === "|+" ||
              sRaw === ">" || sRaw === ">-" || sRaw === ">+") {
            const fold = sRaw.startsWith(">");
            const { value, nextIdx } = consumeBlockScalar(lines, si + 1, sIndent);
            itemObj[sKey] = fold ? value.replace(/\n/g, " ").trim() : value;
            i = nextIdx;
          } else if (sRaw) {
            itemObj[sKey] = parseInlineValue(sRaw);
            i = si + 1;
          } else {
            const nextContent = skipEmpty(lines, si + 1);
            if (nextContent < lines.length && indentOf(lines[nextContent]) > sIndent) {
              const nested = parseBlock(lines, nextContent, indentOf(lines[nextContent]));
              itemObj[sKey] = nested.value;
              i = nested.nextIdx;
            } else {
              itemObj[sKey] = null;
              i = si + 1;
            }
          }
        }

        arr.push(itemObj);
      } else {
        // Plain scalar item
        arr.push(parseScalar(afterDash));
        i = ci + 1;
      }
    }
  }

  return { value: arr, nextIdx: i };
}

function consumeBlockScalar(
  lines: string[],
  startIdx: number,
  parentIndent: number,
): { value: string; nextIdx: number } {
  const collected: string[] = [];
  let i = startIdx;
  let scalarIndent = -1;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank lines within block scalars are preserved
    if (!trimmed) {
      if (scalarIndent !== -1) collected.push("");
      i++;
      continue;
    }

    const indent = indentOf(line);
    if (indent <= parentIndent) break;

    if (scalarIndent === -1) scalarIndent = indent;
    if (indent < scalarIndent) break;

    collected.push(line.slice(scalarIndent));
    i++;
  }

  // Trim trailing empty lines
  while (collected.length > 0 && collected[collected.length - 1] === "") {
    collected.pop();
  }

  return { value: collected.join("\n"), nextIdx: i };
}

function parseInlineValue(raw: string): any {
  if (raw.startsWith("[")) return parseFlowSequence(raw);
  return parseScalar(raw);
}

export function parseFlowSequence(s: string): any[] {
  // Find matching ]
  let depth = 0;
  let end = -1;
  let inQuote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === inQuote && s[i - 1] !== "\\") inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") { inQuote = c; continue; }
    if (c === "[") depth++;
    if (c === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) end = s.length;
  const inner = s.slice(1, end).trim();
  if (!inner) return [];

  // Split on top-level commas respecting quotes and nested brackets
  const items: string[] = [];
  let current = "";
  let bracketDepth = 0;
  inQuote = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inQuote) {
      current += c;
      if (c === inQuote && inner[i - 1] !== "\\") inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") { inQuote = c; current += c; continue; }
    if (c === "[") { bracketDepth++; current += c; continue; }
    if (c === "]") { bracketDepth--; current += c; continue; }
    if (c === "," && bracketDepth === 0) { items.push(current.trim()); current = ""; continue; }
    current += c;
  }
  if (current.trim()) items.push(current.trim());

  return items.map(parseScalar);
}

function parseScalar(s: string): any {
  s = stripComment(s).trim();
  if (!s) return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (s === "null" || s === "~") return null;
  // Quoted strings
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // Numbers — only if the entire string is numeric and not a leading-zero integer (version-like)
  const isNumeric = /^-?\d+(\.\d+)?$/.test(s);
  const isLeadingZeroInteger = /^-?0\d+$/.test(s);
  if (isNumeric && !isLeadingZeroInteger) {
    const n = Number(s);
    if (!isNaN(n)) return n;
  }
  return s;
}

function stripComment(s: string): string {
  let inQuote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      // Handle escaped quotes in double-quoted strings
      if (c === "\\" && inQuote === '"') { i++; continue; }
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") { inQuote = c; continue; }
    // GitHub Actions expressions ${{ }} can contain # — skip them
    if (c === "$" && s[i + 1] === "{" && s[i + 2] === "{") {
      const closeIdx = s.indexOf("}}", i + 3);
      if (closeIdx !== -1) { i = closeIdx + 1; continue; }
    }
    if (c === "#" && (i === 0 || s[i - 1] === " " || s[i - 1] === "\t")) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

/** Find the first colon that's a key separator (not inside quotes or expressions). */
function findKeyColon(s: string): number {
  let inQuote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === "\\" && inQuote === '"') { i++; continue; }
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") { inQuote = c; continue; }
    if (c === ":" && (i + 1 >= s.length || s[i + 1] === " " || s[i + 1] === "\n")) {
      return i;
    }
  }
  return -1;
}

function indentOf(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === " ") n++;
    else break;
  }
  return n;
}

function skipEmpty(lines: string[], startIdx: number): number {
  let i = startIdx;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed && !trimmed.startsWith("#")) return i;
    i++;
  }
  return i;
}

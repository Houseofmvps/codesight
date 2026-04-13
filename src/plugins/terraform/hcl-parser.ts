import type { HclBlock, NestedBlock } from "./types.js";

/**
 * Parse all top-level HCL blocks from a .tf file.
 * Uses regex + brace-counting — zero dependencies.
 */
export function parseHclFile(content: string, filePath: string): HclBlock[] {
  const cleaned = stripComments(content);
  return parseTopLevelBlocks(cleaned, filePath);
}

/**
 * Parse a .tfvars file into simple key=value pairs.
 * tfvars files are flat: `key = value` per line, no blocks.
 * NOTE: multiline values (lists, maps, heredocs) are silently truncated to the first line.
 * This is sufficient for scalar overrides (enable flags, counts, tags) but won't capture
 * complex tfvars structures. Extend if needed.
 */
export function parseTfvars(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const cleaned = stripComments(content);

  for (const line of cleaned.split("\n")) {
    const match = line.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    result[match[1]] = stripQuotes(match[2].trim());
  }

  return result;
}

// ─── Comment Stripping ───

/**
 * Strip HCL comments while preserving string contents.
 * Handles #, //, and block comments.
 */
export function stripComments(content: string): string {
  const result: string[] = [];
  let i = 0;
  let inBlockComment = false;
  let inString = false;
  let heredocDelimiter: string | null = null;

  while (i < content.length) {
    // Inside heredoc: pass through verbatim until closing delimiter
    if (heredocDelimiter !== null) {
      const lineEnd = content.indexOf("\n", i);
      const line = lineEnd === -1 ? content.slice(i) : content.slice(i, lineEnd);
      if (line.trim() === heredocDelimiter) {
        heredocDelimiter = null;
      }
      result.push(lineEnd === -1 ? line : line + "\n");
      i = lineEnd === -1 ? content.length : lineEnd + 1;
      continue;
    }

    // Inside block comment: scan for */
    if (inBlockComment) {
      if (content[i] === "*" && content[i + 1] === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      // Preserve newlines for line count
      if (content[i] === "\n") result.push("\n");
      i++;
      continue;
    }

    const ch = content[i];

    // Track string state to avoid stripping inside strings
    if (ch === '"' && !inString) {
      inString = true;
      result.push(ch);
      i++;
      continue;
    }
    if (inString) {
      if (ch === "\\" && i + 1 < content.length) {
        result.push(ch, content[i + 1]);
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      result.push(ch);
      i++;
      continue;
    }

    // Heredoc start: <<EOF or <<-EOF
    if (ch === "<" && content[i + 1] === "<") {
      const rest = content.slice(i + 2);
      const heredocMatch = rest.match(/^-?\s*(\w+)/);
      if (heredocMatch) {
        const marker = content.slice(i, i + 2 + heredocMatch[0].length);
        result.push(marker);
        heredocDelimiter = heredocMatch[1];
        i += 2 + heredocMatch[0].length;
        // Advance to next line
        const nl = content.indexOf("\n", i);
        if (nl !== -1) {
          result.push(content.slice(i, nl + 1));
          i = nl + 1;
        }
        continue;
      }
    }

    // Block comment start
    if (ch === "/" && content[i + 1] === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    // Line comment: # or //
    if (ch === "#" || (ch === "/" && content[i + 1] === "/")) {
      // Skip to end of line
      const lineEnd = content.indexOf("\n", i);
      if (lineEnd === -1) break;
      result.push("\n");
      i = lineEnd + 1;
      continue;
    }

    result.push(ch);
    i++;
  }

  return result.join("");
}

// ─── Block Extraction ───

function parseTopLevelBlocks(content: string, filePath: string): HclBlock[] {
  const BLOCK_HEADER = /^(resource|module|data|variable|output|locals|provider|terraform)\s+(?:"([^"]+)"\s+)?(?:"([^"]+)"\s+)?\{/gm;
  const blocks: HclBlock[] = [];
  let match: RegExpExecArray | null;

  while ((match = BLOCK_HEADER.exec(content)) !== null) {
    const blockType = match[1];
    const startAfterBrace = match.index + match[0].length;

    const body = extractBraceBlock(content, startAfterBrace);
    if (body === null) continue;

    // Determine resourceType and label based on block type
    let resourceType: string;
    let label: string;

    if (blockType === "resource" || blockType === "data") {
      // resource "aws_ecs_service" "my_service" { ... }
      resourceType = match[2] ?? "";
      label = match[3] ?? "";
    } else if (blockType === "locals" || blockType === "terraform") {
      // locals { ... } — no labels
      resourceType = blockType;
      label = blockType;
    } else {
      // module "name" { ... }, variable "name" { ... }, etc.
      resourceType = match[2] ?? "";
      label = match[2] ?? "";
    }

    const parsed = parseBlockBody(body);

    blocks.push({
      blockType,
      resourceType,
      label,
      file: filePath,
      attributes: parsed.attributes,
      nestedBlocks: parsed.nestedBlocks,
    });

    // Advance past the block to avoid re-matching nested braces
    BLOCK_HEADER.lastIndex = startAfterBrace + body.length + 1;
  }

  return blocks;
}

// ─── Brace Counting ───

/**
 * Extract content between matched braces, starting after the opening brace.
 * Handles strings, heredocs, and nested braces.
 * Based on the pattern from codesight's extract-go.ts.
 */
export function extractBraceBlock(content: string, startAfterOpenBrace: number): string | null {
  let depth = 1;
  let i = startAfterOpenBrace;
  let inString = false;
  let heredocDelimiter: string | null = null;

  while (i < content.length && depth > 0) {
    // Heredoc handling: scan for closing delimiter on its own line
    if (heredocDelimiter !== null) {
      const lineEnd = content.indexOf("\n", i);
      const line = lineEnd === -1 ? content.slice(i) : content.slice(i, lineEnd);
      if (line.trim() === heredocDelimiter) {
        heredocDelimiter = null;
      }
      i = lineEnd === -1 ? content.length : lineEnd + 1;
      continue;
    }

    const ch = content[i];

    // String handling
    if (ch === '"' && !inString) {
      inString = true;
      i++;
      continue;
    }
    if (inString) {
      if (ch === "\\" && i + 1 < content.length) {
        i += 2; // skip escaped char
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    // Heredoc detection: <<EOF or <<-EOF
    if (ch === "<" && content[i + 1] === "<") {
      const rest = content.slice(i + 2);
      const heredocMatch = rest.match(/^-?\s*(\w+)/);
      if (heredocMatch) {
        heredocDelimiter = heredocMatch[1];
        i += 2 + heredocMatch[0].length;
        // Advance to next line
        const nl = content.indexOf("\n", i);
        i = nl === -1 ? content.length : nl + 1;
        continue;
      }
    }

    if (ch === "{") depth++;
    else if (ch === "}") depth--;

    i++;
  }

  if (depth !== 0) return null;
  return content.slice(startAfterOpenBrace, i - 1);
}

// ─── Block Body Parsing ───

interface ParsedBody {
  attributes: Record<string, string>;
  nestedBlocks: Record<string, NestedBlock[]>;
}

function parseBlockBody(body: string): ParsedBody {
  const attributes: Record<string, string> = {};
  const nestedBlocks: Record<string, NestedBlock[]> = {};

  let i = 0;
  const lines = body.split("\n");

  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip empty lines
    if (!line) {
      i++;
      continue;
    }

    // Check for nested block: `identifier {`
    const nestedBlockMatch = line.match(/^(\w+)\s*\{$/);
    if (nestedBlockMatch) {
      const blockName = nestedBlockMatch[1];
      // Find matching close brace by brace-counting in remaining lines
      const remaining = lines.slice(i).join("\n");
      const braceStart = remaining.indexOf("{") + 1;
      const blockBody = extractBraceBlock(remaining, braceStart);

      if (blockBody !== null) {
        const nested = parseBlockBody(blockBody);
        if (!nestedBlocks[blockName]) nestedBlocks[blockName] = [];
        nestedBlocks[blockName].push({ attributes: nested.attributes });

        // Skip past the block
        const blockLines = (remaining.slice(0, braceStart + blockBody.length + 1)).split("\n").length;
        i += blockLines;
        continue;
      }
    }

    // Check for dynamic block: `dynamic "name" {`
    const dynamicMatch = line.match(/^dynamic\s+"(\w+)"\s*\{$/);
    if (dynamicMatch) {
      const blockName = dynamicMatch[1];
      const remaining = lines.slice(i).join("\n");
      const braceStart = remaining.indexOf("{") + 1;
      const blockBody = extractBraceBlock(remaining, braceStart);

      if (blockBody !== null) {
        if (!nestedBlocks[blockName]) nestedBlocks[blockName] = [];
        nestedBlocks[blockName].push({ attributes: { _dynamic: "true" } });
        const blockLines = (remaining.slice(0, braceStart + blockBody.length + 1)).split("\n").length;
        i += blockLines;
        continue;
      }
    }

    // Check for attribute with list-of-maps: `key = [`
    const listStartMatch = line.match(/^(\w+)\s*=\s*\[$/);
    if (listStartMatch) {
      const key = listStartMatch[1];
      const remaining = lines.slice(i).join("\n");
      const bracketStart = remaining.indexOf("[") + 1;
      const listBody = extractBracketBlock(remaining, bracketStart);

      if (listBody !== null) {
        const entries = parseListOfMaps(listBody);
        if (entries.length > 0) {
          if (!nestedBlocks[key]) nestedBlocks[key] = [];
          for (const entry of entries) {
            nestedBlocks[key].push({ attributes: entry });
          }
        } else {
          // Store as raw attribute
          attributes[key] = `[${listBody.trim()}]`;
        }
        const listLines = (remaining.slice(0, bracketStart + listBody.length + 1)).split("\n").length;
        i += listLines;
        continue;
      }
    }

    // Check for simple attribute: `key = value`
    const attrMatch = line.match(/^(\w[\w-]*)\s*=\s*(.+)$/);
    if (attrMatch) {
      const key = attrMatch[1];
      let value = attrMatch[2].trim();

      // Multi-line value: string continuation or heredoc
      if (value.startsWith("<<")) {
        const heredocMatch = value.match(/^<<-?\s*(\w+)/);
        if (heredocMatch) {
          const delimiter = heredocMatch[1];
          const heredocLines: string[] = [];
          i++;
          while (i < lines.length && lines[i].trim() !== delimiter) {
            heredocLines.push(lines[i]);
            i++;
          }
          value = heredocLines.join("\n");
        }
      } else if (value === "{") {
        // Inline block as attribute value
        const remaining = lines.slice(i).join("\n");
        const eqPos = remaining.indexOf("=");
        const bracePos = remaining.indexOf("{", eqPos);
        const blockBody = extractBraceBlock(remaining, bracePos + 1);
        if (blockBody !== null) {
          value = `{${blockBody.trim()}}`;
          const blockLines = (remaining.slice(0, bracePos + 1 + blockBody.length + 1)).split("\n").length;
          i += blockLines;
          continue;
        }
      } else if (value === "[") {
        // Multi-line list — string-aware bracket counting
        const listLines: string[] = [value];
        i++;
        let bracketDepth = 1;
        while (i < lines.length && bracketDepth > 0) {
          listLines.push(lines[i]);
          let inStr = false;
          for (let ci = 0; ci < lines[i].length; ci++) {
            const ch = lines[i][ci];
            if (ch === '"' && !inStr) { inStr = true; continue; }
            if (inStr) {
              if (ch === "\\" && ci + 1 < lines[i].length) { ci++; continue; }
              if (ch === '"') inStr = false;
              continue;
            }
            if (ch === "[") bracketDepth++;
            if (ch === "]") bracketDepth--;
          }
          i++;
        }
        value = listLines.join("\n");
        attributes[key] = stripQuotes(value);
        continue;
      }

      attributes[key] = stripQuotes(value);
      i++;
      continue;
    }

    i++;
  }

  return { attributes, nestedBlocks };
}

// ─── List-of-Maps Parser ───

/**
 * Parse `[{ name = "X", value = "Y" }, { name = "A", value = "B" }]`
 * Returns array of key-value records.
 */
function parseListOfMaps(listBody: string): Record<string, string>[] {
  const entries: Record<string, string>[] = [];
  let i = 0;

  while (i < listBody.length) {
    // Find next opening brace
    const bracePos = listBody.indexOf("{", i);
    if (bracePos === -1) break;

    const body = extractBraceBlock(listBody, bracePos + 1);
    if (body === null) break;

    const record: Record<string, string> = {};
    // Parse comma/newline-separated key = value pairs
    for (const part of body.split(/[,\n]/)) {
      const kv = part.trim().match(/^(\w+)\s*=\s*(.+?)\s*$/);
      if (kv) {
        record[kv[1]] = stripQuotes(kv[2].trim());
      }
    }
    if (Object.keys(record).length > 0) {
      entries.push(record);
    }

    i = bracePos + 1 + body.length + 1;
  }

  return entries;
}

// ─── Bracket Block Extraction ───

function extractBracketBlock(content: string, startAfterOpenBracket: number): string | null {
  let depth = 1;
  let i = startAfterOpenBracket;
  let inString = false;

  while (i < content.length && depth > 0) {
    const ch = content[i];

    if (ch === '"' && !inString) {
      inString = true;
      i++;
      continue;
    }
    if (inString) {
      if (ch === "\\" && i + 1 < content.length) {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    i++;
  }

  if (depth !== 0) return null;
  return content.slice(startAfterOpenBracket, i - 1);
}

// ─── Helpers ───

function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

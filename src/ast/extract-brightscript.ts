/**
 * BrightScript (.brs) extraction.
 *
 * Regex-based — BrightScript has no official AST parser available as a Node
 * dependency, and real-world .brs code is simple enough for line-oriented
 * regex to achieve good recall. Matches the convention of extract-swift,
 * extract-dart, extract-php, etc.
 *
 * Exposed helpers:
 * - extractBrightScriptFunctions: top-level function/sub declarations
 * - extractBrightScriptObservers: m.top.observeField / m.global.observeField
 * - extractBrightScriptShowScreenCalls: ShowScreen / CloseScreen / GetCurrentScreen
 * - extractBrightScriptGraphqlCalls: makeGraphqlCall / roUrlTransfer site hits
 * - extractBrightScriptGlobalFields: m.global.AddField(...) registrations
 * - extractBrightScriptRudderstackEvents: event names passed to RudderstackTask
 */

import type { ExportItem } from "../types.js";

export interface BrightScriptObserver {
  field: string;
  handler: string;
  scope: "top" | "global" | "other";
  line: number;
}

export interface ShowScreenCall {
  target: string;   // variable/expression referenced (e.g. "m.homeView" or "homeView")
  modal: boolean;   // true when the second positional arg is a literal `true`
  helper: "show" | "close" | "current";
  line: number;
}

export interface GraphqlCallSite {
  url: string;      // literal text or expression as source
  /** Line number (1-indexed) of the call-site. */
  line: number;
}

export interface GlobalFieldRegistration {
  name: string;
  type: string;
  line: number;
}

export interface RudderstackEvent {
  name: string;
  line: number;
}

/**
 * Extract top-level function / sub declarations from .brs source.
 *
 * BrightScript syntax is case-insensitive. Declarations we recognize:
 *   function Foo(a, b as string) as object
 *   Function Foo()
 *   sub Bar(x)
 *   Sub Bar()
 *
 * We only match declarations that begin at column 0 to exclude nested
 * inline function expressions (which BrightScript supports inside tables).
 */
export function extractBrightScriptFunctions(content: string): ExportItem[] {
  const exports: ExportItem[] = [];
  const lines = content.split("\n");
  const declPattern = /^(function|sub)\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/i;

  const seen = new Set<string>();
  for (const line of lines) {
    const m = line.match(declPattern);
    if (!m) continue;
    const kind = m[1].toLowerCase() === "sub" ? "sub" : "function";
    const name = m[2];
    const params = m[3].trim();
    if (seen.has(name)) continue;
    seen.add(name);
    exports.push({
      name,
      kind: "function",
      signature: `${kind} ${name}(${params})`,
    });
  }

  return exports;
}

/**
 * Extract observeField / observeFieldScoped registrations.
 *
 * Patterns recognized:
 *   m.top.observeField("fieldName", "handlerName")
 *   m.global.observeField("fieldName", "handlerName")
 *   someNode.observeField("fieldName", "handlerName")
 *   m.top.observeFieldScoped("fieldName", "handlerName")
 */
export function extractBrightScriptObservers(content: string): BrightScriptObserver[] {
  const out: BrightScriptObserver[] = [];
  const lines = content.split("\n");
  const pattern = /(\bm\.top|\bm\.global|\b[\w.]+?)\.observeField(?:Scoped)?\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/gi;

  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(lines[i])) !== null) {
      const receiver = match[1];
      let scope: BrightScriptObserver["scope"] = "other";
      if (/^m\.top$/i.test(receiver)) scope = "top";
      else if (/^m\.global$/i.test(receiver)) scope = "global";
      out.push({ field: match[2], handler: match[3], scope, line: i + 1 });
    }
  }
  return out;
}

/**
 * Extract screen-stack navigation call-sites.
 *
 * Matches the helpers named in the repo conventions used by this detector:
 *   ShowScreen(target)
 *   ShowScreen(target, true)
 *   CloseScreen()
 *   GetCurrentScreen()
 */
export function extractBrightScriptShowScreenCalls(content: string): ShowScreenCall[] {
  const out: ShowScreenCall[] = [];
  const lines = content.split("\n");

  const showPattern = /\bShowScreen\s*\(\s*([^),]+?)\s*(?:,\s*(true|false|\w+))?\s*\)/gi;
  const closePattern = /\bCloseScreen\s*\(\s*\)/gi;
  const currentPattern = /\bGetCurrentScreen\s*\(\s*\)/gi;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;

    showPattern.lastIndex = 0;
    while ((m = showPattern.exec(line)) !== null) {
      const target = m[1].trim();
      const second = (m[2] ?? "").trim().toLowerCase();
      out.push({
        target,
        modal: second === "true",
        helper: "show",
        line: i + 1,
      });
    }

    closePattern.lastIndex = 0;
    while ((m = closePattern.exec(line)) !== null) {
      out.push({ target: "", modal: false, helper: "close", line: i + 1 });
    }

    currentPattern.lastIndex = 0;
    while ((m = currentPattern.exec(line)) !== null) {
      out.push({ target: "", modal: false, helper: "current", line: i + 1 });
    }
  }

  return out;
}

/**
 * Extract GraphQL + raw HTTP call sites.
 *
 * makeGraphqlCall(url, payload, params) — used across FrontRow Roku code.
 * Also catches bare CreateObject("roUrlTransfer").
 */
export function extractBrightScriptGraphqlCalls(content: string): GraphqlCallSite[] {
  const out: GraphqlCallSite[] = [];
  const lines = content.split("\n");
  const gqlPattern = /\bmakeGraphqlCall\s*\(\s*([^,]+?)\s*,/gi;
  const urlXferPattern = /\bCreateObject\s*\(\s*["']roUrlTransfer["']\s*\)/gi;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    gqlPattern.lastIndex = 0;
    while ((m = gqlPattern.exec(line)) !== null) {
      out.push({ url: m[1].trim(), line: i + 1 });
    }
    urlXferPattern.lastIndex = 0;
    while ((m = urlXferPattern.exec(line)) !== null) {
      out.push({ url: "roUrlTransfer", line: i + 1 });
    }
  }

  return out;
}

/**
 * Extract m.global.AddField("name", "type", ...) registrations.
 * Used by middleware + config detectors as app-wide declared state.
 */
export function extractBrightScriptGlobalFields(content: string): GlobalFieldRegistration[] {
  const out: GlobalFieldRegistration[] = [];
  const lines = content.split("\n");
  const pattern = /\bm\.global\.(?:AddField|addField)\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/gi;
  for (let i = 0; i < lines.length; i++) {
    let m: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(lines[i])) !== null) {
      out.push({ name: m[1], type: m[2], line: i + 1 });
    }
  }
  return out;
}

/**
 * Heuristic: RudderstackTask event name payloads.
 *
 * Common shapes in FrontRow code:
 *   rudderstackTask.event = { event: "EventName", properties: {...} }
 *   rudderstackTask.callFunc("trackEvent", "EventName", {...})
 */
export function extractBrightScriptRudderstackEvents(content: string): RudderstackEvent[] {
  const out: RudderstackEvent[] = [];
  const lines = content.split("\n");
  const eventFieldPattern = /\bevent\s*:\s*["']([^"']+)["']/gi;
  const callFuncPattern = /rudderstack[\w.]*\.callFunc\s*\(\s*["'][^"']*["']\s*,\s*["']([^"']+)["']/gi;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only treat `event: "..."` as a rudderstack event when rudderstack is named
    // nearby; this avoids false-positives on generic code.
    if (/rudderstack/i.test(line) || /\btrackEvent\b/i.test(line)) {
      let m: RegExpExecArray | null;
      eventFieldPattern.lastIndex = 0;
      while ((m = eventFieldPattern.exec(line)) !== null) {
        out.push({ name: m[1], line: i + 1 });
      }
    }
    let m: RegExpExecArray | null;
    callFuncPattern.lastIndex = 0;
    while ((m = callFuncPattern.exec(line)) !== null) {
      out.push({ name: m[1], line: i + 1 });
    }
  }
  return out;
}

/**
 * Find `m.xxxView = m.top.findNode("xxxView")` style bindings.
 * Used by routes detector to resolve `ShowScreen(m.xxxView)` back to a node id.
 */
export function extractFindNodeBindings(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");
  const pattern = /\bm\.(\w+)\s*=\s*m\.top\.findNode\s*\(\s*["']([^"']+)["']\s*\)/i;
  for (const line of lines) {
    const m = line.match(pattern);
    if (!m) continue;
    result[`m.${m[1]}`] = m[2];
  }
  return result;
}

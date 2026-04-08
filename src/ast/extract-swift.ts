/**
 * Swift / SwiftUI / Vapor extraction.
 * Regex-based — no Swift compiler needed.
 *
 * Supports:
 * - SwiftUI: struct X: View detection → ComponentInfo
 * - Vapor: app.get(), app.post(), routes.get(), etc.
 * - Swift public exports: public class/struct/func/protocol/enum
 */

import type { RouteInfo, ComponentInfo, ExportItem } from "../types.js";

function extractPathParams(path: string): string[] {
  const params: string[] = [];
  // Vapor uses :param syntax
  const regex = /:(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(path)) !== null) params.push(m[1]);
  return params;
}

// ─── Vapor routes ──────────────────────────────────────────────────────────

const VAPOR_HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;

export function extractVaporRoutes(
  filePath: string,
  content: string,
  tags: string[]
): RouteInfo[] {
  const routes: RouteInfo[] = [];

  if (
    !content.includes("app.get") &&
    !content.includes("app.post") &&
    !content.includes("routes.get") &&
    !content.includes("routes.post") &&
    !content.includes("grouped") &&
    !content.includes("RouteCollection")
  ) {
    return routes;
  }

  for (const method of VAPOR_HTTP_METHODS) {
    // app.get("users", ":id") or routes.post("auth", "login")
    // Vapor uses variadic string segments: app.get("segment1", "segment2", ":param")
    const pattern = new RegExp(
      `(?:app|routes|router)\\s*\\.\\s*${method}\\s*\\(([^{]+?)(?:,\\s*use:|\\s*\\{)`,
      "g"
    );
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const argsRaw = m[1];
      // Extract all string segments
      const segments: string[] = [];
      const segPattern = /["']([^"']+)["']/g;
      let seg: RegExpExecArray | null;
      while ((seg = segPattern.exec(argsRaw)) !== null) {
        segments.push(seg[1]);
      }
      if (segments.length === 0) continue;

      const path = "/" + segments.join("/");
      routes.push({
        method: method.toUpperCase(),
        path,
        file: filePath,
        tags,
        framework: "vapor",
        params: extractPathParams(path),
        confidence: "regex",
      });
    }

    // Also handle: app.on(.GET, "path") style
    const onPattern = new RegExp(
      `\\.on\\s*\\(\\s*\\.${method.toUpperCase()}\\s*,\\s*["']([^"']+)["']`,
      "gi"
    );
    while ((m = onPattern.exec(content)) !== null) {
      const path = m[1].startsWith("/") ? m[1] : "/" + m[1];
      routes.push({
        method: method.toUpperCase(),
        path,
        file: filePath,
        tags,
        framework: "vapor",
        params: extractPathParams(path),
        confidence: "regex",
      });
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return routes.filter((r) => {
    const key = `${r.method}:${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── SwiftUI view detection ────────────────────────────────────────────────

const SWIFTUI_PROTOCOLS = [
  "View",
  "PreviewProvider",
  "UIViewRepresentable",
  "UIViewControllerRepresentable",
  "NSViewRepresentable",
];

export function extractSwiftUIViews(
  filePath: string,
  content: string
): ComponentInfo[] {
  const views: ComponentInfo[] = [];

  for (const proto of SWIFTUI_PROTOCOLS) {
    if (proto === "PreviewProvider") continue; // skip preview structs
    // struct MyView: View or struct MyView: View, SomeOtherProtocol
    const pattern = new RegExp(
      `struct\\s+(\\w+)\\s*:\\s*(?:[\\w, .]*\\b)?${proto}\\b`,
      "g"
    );
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const name = m[1];
      if (name.startsWith("_")) continue;

      // Extract @State, @Binding, @ObservedObject properties as "props"
      const props = extractSwiftViewProps(content, name);

      views.push({
        name,
        file: filePath,
        props,
        isClient: true,
        isServer: false,
      });
    }
  }

  return views;
}

function extractSwiftViewProps(content: string, _viewName: string): string[] {
  const props: string[] = [];
  // @Binding var propName: Type
  // @State var stateName: Type
  // var propName: Type (simple stored property)
  const propPattern =
    /(?:@(?:Binding|State|ObservedObject|EnvironmentObject|StateObject|Environment)\s+)?var\s+(\w+)\s*:\s*[\w<>?,\s\[\]]+/g;
  let m: RegExpExecArray | null;
  while ((m = propPattern.exec(content)) !== null) {
    const name = m[1];
    if (name.startsWith("_") || name === "body" || name === "previews") continue;
    if (!props.includes(name)) props.push(name);
  }
  return props.slice(0, 10);
}

// ─── Swift public exports ──────────────────────────────────────────────────

export function extractSwiftExports(content: string): ExportItem[] {
  const exports: ExportItem[] = [];

  // public/open class/struct/enum/protocol/actor TypeName
  const typePattern =
    /(?:^|\n)\s*(?:public|open)\s+(?:final\s+|class\s+|struct\s+|enum\s+|protocol\s+|actor\s+)?(?:(class|struct|enum|protocol|actor))\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = typePattern.exec(content)) !== null) {
    const kind = m[1] === "protocol" ? "interface" : m[1] === "enum" ? "enum" : "class";
    exports.push({ name: m[2], kind });
  }

  // public func functionName(
  const funcPattern =
    /(?:^|\n)\s*(?:public|open)\s+(?:static\s+|class\s+|mutating\s+)?func\s+(\w+)\s*[(<]/g;
  while ((m = funcPattern.exec(content)) !== null) {
    const name = m[1];
    if (!exports.some((e) => e.name === name)) {
      exports.push({ name, kind: "function" });
    }
  }

  return exports;
}

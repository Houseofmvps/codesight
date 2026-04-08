/**
 * Dart / Flutter extraction.
 * Regex-based — no Dart compiler needed.
 *
 * Supports:
 * - go_router: GoRoute(path: '/path') detection
 * - Widget detection: StatelessWidget, StatefulWidget, ConsumerWidget, HookWidget
 * - Dart public exports: classes, functions (no leading _ = public in Dart)
 */

import type { RouteInfo, ComponentInfo, ExportItem } from "../types.js";

function extractPathParams(path: string): string[] {
  const params: string[] = [];
  const regex = /:(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(path)) !== null) params.push(m[1]);
  return params;
}

// ─── go_router routes ──────────────────────────────────────────────────────

export function extractFlutterRoutes(
  filePath: string,
  content: string,
  tags: string[]
): RouteInfo[] {
  const routes: RouteInfo[] = [];

  if (!content.includes("go_router") && !content.includes("GoRoute") && !content.includes("GoRouter")) {
    return routes;
  }

  // GoRoute(path: '/path', ...) — handles single and double quotes
  const goRoutePattern = /GoRoute\s*\([^)]*path\s*:\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = goRoutePattern.exec(content)) !== null) {
    const path = m[1];
    routes.push({
      method: "GET",
      path,
      file: filePath,
      tags,
      framework: "flutter",
      params: extractPathParams(path),
      confidence: "regex",
    });
  }

  // ShellRoute / StatefulShellRoute — treated as GET navigation routes
  const shellRoutePattern = /StatefulShellRoute[^(]*\([^)]*path\s*:\s*['"]([^'"]+)['"]/g;
  while ((m = shellRoutePattern.exec(content)) !== null) {
    const path = m[1];
    if (!routes.some((r) => r.path === path)) {
      routes.push({
        method: "GET",
        path,
        file: filePath,
        tags,
        framework: "flutter",
        params: extractPathParams(path),
        confidence: "regex",
      });
    }
  }

  return routes;
}

// ─── Flutter widget detection ──────────────────────────────────────────────

const WIDGET_BASE_CLASSES = [
  "StatelessWidget",
  "StatefulWidget",
  "ConsumerWidget",        // Riverpod
  "HookWidget",            // flutter_hooks
  "HookConsumerWidget",    // Riverpod + hooks
  "ConsumerStatefulWidget",
  "InheritedWidget",
  "InheritedNotifier",
  "InheritedModel",
];

export function extractFlutterWidgets(
  filePath: string,
  content: string
): ComponentInfo[] {
  const widgets: ComponentInfo[] = [];

  for (const base of WIDGET_BASE_CLASSES) {
    // class MyWidget extends StatelessWidget
    const pattern = new RegExp(`class\\s+(\\w+)\\s+extends\\s+(?:[\\w.]+\\.)?${base}\\b`, "g");
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const name = m[1];
      if (name.startsWith("_")) continue; // private widget

      // Extract constructor named parameters as "props"
      const props = extractDartConstructorParams(content, name);

      widgets.push({
        name,
        file: filePath,
        props,
        isClient: true,
        isServer: false,
      });
    }
  }

  return widgets;
}

function extractDartConstructorParams(content: string, className: string): string[] {
  const props: string[] = [];
  // const WidgetName({ required this.param1, this.param2, Key? key })
  const ctorPattern = new RegExp(
    `${className}\\s*\\(\\s*\\{([^}]+)\\}`,
    "s"
  );
  const m = content.match(ctorPattern);
  if (!m) return props;

  const paramsBlock = m[1];
  // Match: required this.name, this.name, final Type name
  const paramPattern = /(?:required\s+)?(?:final\s+)?(?:[\w<>?, \[\]]+\s+)?this\.(\w+)|(?:required\s+)?(?:final\s+)[\w<>?, \[\]]+\s+(\w+)/g;
  let pm: RegExpExecArray | null;
  while ((pm = paramPattern.exec(paramsBlock)) !== null) {
    const name = pm[1] || pm[2];
    if (name && name !== "key" && !name.startsWith("_")) {
      props.push(name);
    }
  }

  return props.slice(0, 10);
}

// ─── Dart public exports ───────────────────────────────────────────────────

export function extractDartExports(content: string): ExportItem[] {
  const exports: ExportItem[] = [];

  // class/abstract class/mixin/enum ClassName (public = no _ prefix)
  const typePattern = /(?:^|\n)\s*(?:abstract\s+|sealed\s+|final\s+|base\s+)?(?:(class|mixin|enum|extension))\s+([A-Z]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = typePattern.exec(content)) !== null) {
    const kind = m[1] === "enum" ? "enum" : m[1] === "mixin" ? "class" : "class";
    exports.push({ name: m[2], kind });
  }

  // Top-level public functions: return_type functionName(
  // Dart: void doSomething(), Future<X> fetchData(), String getName()
  const fnPattern = /(?:^|\n)\s*(?:Future<?[\w<>, \[\]]*>?|Stream<?[\w<>, \[\]]*>?|[\w<>?, \[\]]+)\s+([a-z]\w+)\s*\(/g;
  while ((m = fnPattern.exec(content)) !== null) {
    const name = m[1];
    if (name.startsWith("_")) continue; // private
    // Skip Dart keywords and common noise
    if (["if", "else", "for", "while", "switch", "return", "await", "async"].includes(name)) continue;
    if (!exports.some((e) => e.name === name)) {
      exports.push({ name, kind: "function" });
    }
  }

  return exports;
}

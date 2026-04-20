/**
 * Roku SceneGraph XML extraction.
 *
 * SceneGraph components are XML files that declare:
 * - a component name + parent type  (`<component name="X" extends="Group">`)
 * - public fields/functions (`<interface> <field ... /> </interface>`)
 * - script includes             (`<script uri="pkg:/..." />`)
 * - nested child components     (`<children> <Label .../> </children>`)
 *
 * This file exposes two regex-based extractors — no XML parser dependency,
 * matching the style of every other extractor in src/ast/.
 */

import type { SchemaField } from "../types.js";

export interface SceneGraphComponent {
  /** Value of the `name=` attribute on the top-level <component>. */
  name: string;
  /** Value of the `extends=` attribute, or "Group" as a conservative default. */
  extendsType: string;
  /** Fields declared under <interface> — drives schema + components detectors. */
  interfaceFields: SchemaField[];
  /** Functions declared under <interface> — drives libs detector for XML side. */
  interfaceFunctions: string[];
  /** Script include targets from <script uri="pkg:/..." />. */
  scriptIncludes: string[];
  /** Direct child component type names declared under <children>. */
  childComponents: string[];
}

/**
 * Parse a single SceneGraph component XML file.
 *
 * Returns null for XML that is not a SceneGraph component (Android layouts,
 * Spring configs, raw XML data, etc.). The signature is a top-level
 * `<component name="..." extends="...">` element.
 */
export function extractSceneGraphComponent(content: string): SceneGraphComponent | null {
  const componentMatch = content.match(/<component\s+([^>]+?)\s*(?:>|\/>)/i);
  if (!componentMatch) return null;

  const attrs = componentMatch[1];
  const name = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!name) return null;
  const extendsType = attrs.match(/\bextends\s*=\s*["']([^"']+)["']/i)?.[1] ?? "Group";

  const interfaceFields: SchemaField[] = [];
  const interfaceFunctions: string[] = [];
  const interfaceBlock = content.match(/<interface\b[^>]*>([\s\S]*?)<\/interface>/i);
  if (interfaceBlock) {
    const body = interfaceBlock[1];

    const fieldPattern = /<field\s+([^>]+?)\s*\/?\s*>/gi;
    let m: RegExpExecArray | null;
    while ((m = fieldPattern.exec(body)) !== null) {
      const fieldAttrs = m[1];
      const id = fieldAttrs.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!id) continue;
      const rawType = fieldAttrs.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1] ?? "unknown";
      const hasDefault = /\bvalue\s*=/i.test(fieldAttrs) || /\bdefault\s*=/i.test(fieldAttrs);
      const isAlias = /\balias\s*=/i.test(fieldAttrs);
      const flags: string[] = [];
      if (hasDefault) flags.push("default");
      if (isAlias) flags.push("alias");
      interfaceFields.push({ name: id, type: normalizeSceneGraphType(rawType), flags });
    }

    const functionPattern = /<function\s+([^>]+?)\s*\/?\s*>/gi;
    while ((m = functionPattern.exec(body)) !== null) {
      const fnName = m[1].match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
      if (fnName) interfaceFunctions.push(fnName);
    }
  }

  const scriptIncludes: string[] = [];
  const scriptPattern = /<script\s+([^>]+?)\s*\/?\s*>/gi;
  let s: RegExpExecArray | null;
  while ((s = scriptPattern.exec(content)) !== null) {
    const uri = s[1].match(/\buri\s*=\s*["']([^"']+)["']/i)?.[1];
    if (uri) scriptIncludes.push(uri);
  }

  const childComponents: string[] = [];
  const childrenBlock = content.match(/<children\b[^>]*>([\s\S]*?)<\/children>/i);
  if (childrenBlock) {
    const body = childrenBlock[1];
    // Match any element open tag — component types are uppercase-initial by convention
    const childPattern = /<([A-Z][\w:-]*)\b/g;
    let c: RegExpExecArray | null;
    while ((c = childPattern.exec(body)) !== null) {
      childComponents.push(c[1]);
    }
  }

  return { name, extendsType, interfaceFields, interfaceFunctions, scriptIncludes, childComponents };
}

/**
 * For a MainScene xml, return the map of `{ id -> componentType }` describing
 * every child view slot. Values of `m.top.findNode("xxx")` in MainScene.brs
 * resolve back to these IDs.
 *
 * Roku Scene XML typically looks like:
 *   <component name="MainScene" extends="Scene">
 *     <children>
 *       <HomeView id="homeView" />
 *       <LoginView id="loginView" />
 *     </children>
 *   </component>
 */
export function extractMainSceneScreens(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const childrenBlock = content.match(/<children\b[^>]*>([\s\S]*?)<\/children>/i);
  if (!childrenBlock) return result;

  const body = childrenBlock[1];
  // Each child element: <ComponentType id="slotId" ... />
  const elementPattern = /<([A-Z][\w:-]*)\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = elementPattern.exec(body)) !== null) {
    const componentType = m[1];
    const attrs = m[2];
    const id = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!id) continue;
    result[id] = componentType;
  }
  return result;
}

/**
 * Cheap content sniff: is this XML file a SceneGraph component?
 * Used by detectors to filter the broad `.xml` file set down to SceneGraph XML.
 */
export function isSceneGraphXml(content: string): boolean {
  if (!/<component\b/i.test(content)) return false;
  if (!/\bname\s*=/i.test(content)) return false;
  // Android layouts start with <?xml then a specific Android namespace or a
  // layout root (LinearLayout, ConstraintLayout, etc.). They don't have
  // <component>, so the check above already excludes them. Spring configs
  // use <beans>. Belt-and-braces: reject obvious Android namespaces.
  if (/xmlns:android\s*=/.test(content)) return false;
  return true;
}

function normalizeSceneGraphType(raw: string): string {
  const t = raw.trim().toLowerCase();
  switch (t) {
    case "string":
    case "str":
      return "string";
    case "integer":
    case "int":
      return "int";
    case "float":
      return "float";
    case "boolean":
    case "bool":
      return "bool";
    case "double":
      return "double";
    case "longinteger":
      return "longInteger";
    case "node":
      return "node-ref";
    case "nodearray":
      return "node-ref[]";
    case "array":
      return "array";
    case "assocarray":
      return "object";
    case "color":
      return "color";
    case "vector2d":
      return "vector2d";
    case "rect2d":
      return "rect2d";
    case "time":
      return "time";
    default:
      return raw;
  }
}

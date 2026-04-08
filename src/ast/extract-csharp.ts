/**
 * C# / ASP.NET Core route and Entity Framework model extraction.
 * Regex-based (no external compiler needed).
 *
 * Supports:
 * - Controller-style routes: [HttpGet], [HttpPost], etc. + [Route] class prefix
 * - Minimal API routes: app.MapGet(), app.MapPost(), etc. (Program.cs)
 * - Entity Framework: DbContext subclass → DbSet<Model> extraction
 */

import type { RouteInfo, SchemaModel, SchemaField, ExportItem } from "../types.js";

const CSHARP_HTTP_METHODS = ["Get", "Post", "Put", "Patch", "Delete", "Options", "Head"] as const;

function extractPathParams(path: string): string[] {
  const params: string[] = [];
  const regex = /\{(\w+)(?::[^}]*)?\}/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(path)) !== null) params.push(m[1]);
  return params;
}

// ─── Controller-style routes ───────────────────────────────────────────────

export function extractAspNetControllerRoutes(
  filePath: string,
  content: string,
  tags: string[]
): RouteInfo[] {
  const routes: RouteInfo[] = [];

  // Class-level [Route("prefix")] or [RoutePrefix("prefix")]
  const classRouteMatch = content.match(
    /\[Route(?:Prefix)?\s*\(\s*"([^"]*)"\s*\)\]/
  );
  const classPrefix = classRouteMatch ? classRouteMatch[1] : "";

  for (const method of CSHARP_HTTP_METHODS) {
    // [HttpGet], [HttpGet("path")], [HttpGet("/abs-path")]
    const pattern = new RegExp(
      `\\[Http${method}(?:\\s*\\(\\s*"([^"]*)"\\s*\\))?\\]`,
      "g"
    );
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const subPath = match[1] ?? "";

      let fullPath: string;
      if (subPath.startsWith("/")) {
        // Absolute path — ignore class prefix
        fullPath = subPath;
      } else if (classPrefix && subPath) {
        fullPath = "/" + classPrefix.replace(/^\//, "") + "/" + subPath.replace(/^\//, "");
      } else if (classPrefix) {
        fullPath = "/" + classPrefix.replace(/^\//, "");
      } else if (subPath) {
        fullPath = "/" + subPath.replace(/^\//, "");
      } else {
        fullPath = "/";
      }

      // Normalise double slashes
      fullPath = fullPath.replace(/\/\//g, "/");

      routes.push({
        method: method.toUpperCase(),
        path: fullPath,
        file: filePath,
        tags,
        framework: "aspnet",
        params: extractPathParams(fullPath),
        confidence: "regex",
      });
    }
  }

  return routes;
}

// ─── Minimal API routes (Program.cs) ──────────────────────────────────────

export function extractAspNetMinimalApiRoutes(
  filePath: string,
  content: string,
  tags: string[]
): RouteInfo[] {
  const routes: RouteInfo[] = [];

  // app.MapGet("/path", ...) or endpoints.MapPost("/users/{id}", ...)
  const mapPattern =
    /\.Map(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*"([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = mapPattern.exec(content)) !== null) {
    const path = match[2];
    routes.push({
      method: match[1].toUpperCase(),
      path,
      file: filePath,
      tags,
      framework: "aspnet",
      params: extractPathParams(path),
      confidence: "regex",
    });
  }

  return routes;
}

// ─── Entity Framework models ───────────────────────────────────────────────

export function extractEntityFrameworkModels(
  _filePath: string,
  content: string
): SchemaModel[] {
  const models: SchemaModel[] = [];

  // Find DbContext subclass
  if (
    !content.includes("DbContext") &&
    !content.includes("DbSet<")
  ) {
    return models;
  }

  // Extract each DbSet<ModelName> property
  const dbSetPattern = /DbSet\s*<\s*(\w+)\s*>/g;
  const modelNames = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = dbSetPattern.exec(content)) !== null) {
    modelNames.add(m[1]);
  }

  if (modelNames.size === 0) return models;

  // For each model name, try to find class definition in same file
  for (const modelName of modelNames) {
    const classPattern = new RegExp(
      `class\\s+${modelName}\\s*(?::\\s*[\\w<>, ]+)?\\s*\\{([\\s\\S]*?)\\n\\s*\\}`,
      "m"
    );
    const classMatch = content.match(classPattern);

    if (classMatch) {
      const body = classMatch[1];
      const fields = extractCSharpProperties(body);
      if (fields.length > 0) {
        models.push({
          name: modelName,
          fields,
          relations: extractCSharpRelations(body),
          orm: "entity-framework",
        });
        continue;
      }
    }

    // Model class not in this file — just record the name from DbSet
    models.push({
      name: modelName,
      fields: [],
      relations: [],
      orm: "entity-framework",
    });
  }

  return models;
}

// Extract C# properties from a class body
function extractCSharpProperties(body: string): SchemaField[] {
  const fields: SchemaField[] = [];
  const AUDIT = new Set(["CreatedAt", "UpdatedAt", "DeletedAt", "Timestamp", "RowVersion"]);

  // public string Name { get; set; }
  // public int? Age { get; set; }
  // [Key] public int Id { get; set; }
  const propPattern =
    /(?:\[([^\]]*)\]\s*)?public\s+([\w?<>, \[\]]+?)\s+(\w+)\s*\{\s*get;\s*(?:set;|init;)/g;
  let m: RegExpExecArray | null;
  while ((m = propPattern.exec(body)) !== null) {
    const attributes = m[1] || "";
    const rawType = m[2].trim();
    const name = m[3];

    if (AUDIT.has(name)) continue;
    // Skip navigation properties that are collections or complex types starting with ICollection/List/IEnumerable
    if (/^I?(?:Collection|List|Enumerable|Queryable)</.test(rawType)) continue;

    const type = rawType.replace(/\?$/, ""); // strip nullable ?
    const nullable = rawType.endsWith("?");

    const flags: string[] = [];
    if (attributes.includes("Key") || name === "Id" || name.endsWith("Id") && name === name) {
      if (name === "Id" || attributes.includes("Key")) flags.push("pk");
    }
    if (name.endsWith("Id") && name !== "Id") flags.push("fk");
    if (attributes.includes("Required")) flags.push("required");
    if (nullable) flags.push("nullable");
    if (attributes.includes("MaxLength") || attributes.includes("StringLength")) {
      const lenMatch = attributes.match(/(?:MaxLength|StringLength)\s*\(\s*(\d+)/);
      if (lenMatch) flags.push(`max:${lenMatch[1]}`);
    }

    fields.push({ name, type, flags });
  }

  return fields;
}

// Extract navigation properties / relationships
function extractCSharpRelations(body: string): string[] {
  const relations: string[] = [];
  // public virtual ICollection<Post> Posts { get; set; }
  // public virtual User User { get; set; }
  const navPattern =
    /public\s+virtual\s+(I?(?:Collection|List)<\s*(\w+)\s*>|(\w+))\s+(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = navPattern.exec(body)) !== null) {
    const collectionType = m[2];
    const singleType = m[3];
    const propName = m[4];
    if (collectionType) {
      relations.push(`${propName}: ${collectionType}[]`);
    } else if (singleType && singleType !== "string" && singleType !== "int" && singleType !== "bool") {
      relations.push(`${propName}: ${singleType}`);
    }
  }
  return relations;
}

// ─── C# lib exports ────────────────────────────────────────────────────────

export function extractCSharpExports(content: string): ExportItem[] {
  const exports: ExportItem[] = [];

  // public [static] [abstract] class/interface/enum/record Name
  const typePattern =
    /public\s+(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(?:(class|interface|enum|record|struct))\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = typePattern.exec(content)) !== null) {
    const kind = m[1] === "interface" ? "interface" : m[1] === "enum" ? "enum" : "class";
    exports.push({ name: m[2], kind });
  }

  // public [static] [async] ReturnType MethodName(
  const methodPattern =
    /public\s+(?:static\s+|async\s+|virtual\s+|override\s+)*(?:Task<?[\w<>, \[\]]*>?|[\w<>, \[\]]+)\s+(\w+)\s*\(/g;
  while ((m = methodPattern.exec(content)) !== null) {
    const name = m[1];
    // Skip constructors (same as class name already captured) and common noise
    if (name === "string" || name === "int" || name === "bool" || name === "void") continue;
    if (!exports.some((e) => e.name === name)) {
      exports.push({ name, kind: "function" });
    }
  }

  return exports;
}

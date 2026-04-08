/**
 * Laravel-specific route and Eloquent ORM extraction.
 * Regex-based — no PHP parser needed.
 *
 * Supports:
 * - routes/api.php + routes/web.php: Route::get(), Route::post(), Route::resource(), Route::apiResource()
 * - Eloquent models: extends Model → $fillable, $casts, relationship methods
 */

import type { RouteInfo, SchemaModel, SchemaField, ExportItem } from "../types.js";

function extractPathParams(path: string): string[] {
  const params: string[] = [];
  const regex = /\{(\w+)\??}/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(path)) !== null) params.push(m[1]);
  return params;
}

// ─── Laravel routes ────────────────────────────────────────────────────────

export function extractLaravelRoutes(
  filePath: string,
  content: string,
  tags: string[]
): RouteInfo[] {
  const routes: RouteInfo[] = [];

  // Route::get('/path', ...) Route::post('/path', ...) etc.
  const verbPattern =
    /Route\s*::\s*(get|post|put|patch|delete|options|any)\s*\(\s*['"]([^'"]+)['"]/gi;
  let m: RegExpExecArray | null;
  while ((m = verbPattern.exec(content)) !== null) {
    const method = m[1].toUpperCase() === "ANY" ? "ALL" : m[1].toUpperCase();
    const path = m[2].startsWith("/") ? m[2] : "/" + m[2];
    routes.push({
      method,
      path,
      file: filePath,
      tags,
      framework: "laravel",
      params: extractPathParams(path),
      confidence: "regex",
    });
  }

  // Route::match(['get','post'], '/path', ...)
  const matchPattern =
    /Route\s*::\s*match\s*\(\s*\[([^\]]+)\]\s*,\s*['"]([^'"]+)['"]/gi;
  while ((m = matchPattern.exec(content)) !== null) {
    const methods = m[1].match(/['"](\w+)['"]/g)?.map((s) => s.replace(/['"]/g, "").toUpperCase()) ?? ["ALL"];
    const path = m[2].startsWith("/") ? m[2] : "/" + m[2];
    for (const method of methods) {
      routes.push({
        method,
        path,
        file: filePath,
        tags,
        framework: "laravel",
        params: extractPathParams(path),
        confidence: "regex",
      });
    }
  }

  // Route::resource('photos', PhotoController::class) → standard RESTful routes
  const resourcePattern = /Route\s*::\s*resource\s*\(\s*['"]([^'"]+)['"]/gi;
  while ((m = resourcePattern.exec(content)) !== null) {
    const base = "/" + m[1].replace(/^\//, "");
    const restRoutes: [string, string][] = [
      ["GET", base],
      ["GET", `${base}/create`],
      ["POST", base],
      ["GET", `${base}/{id}`],
      ["GET", `${base}/{id}/edit`],
      ["PUT", `${base}/{id}`],
      ["PATCH", `${base}/{id}`],
      ["DELETE", `${base}/{id}`],
    ];
    for (const [method, path] of restRoutes) {
      routes.push({ method, path, file: filePath, tags, framework: "laravel", params: extractPathParams(path), confidence: "regex" });
    }
  }

  // Route::apiResource('photos', PhotoController::class) → REST without create/edit forms
  const apiResourcePattern = /Route\s*::\s*apiResource\s*\(\s*['"]([^'"]+)['"]/gi;
  while ((m = apiResourcePattern.exec(content)) !== null) {
    const base = "/" + m[1].replace(/^\//, "");
    const apiRoutes: [string, string][] = [
      ["GET", base],
      ["POST", base],
      ["GET", `${base}/{id}`],
      ["PUT", `${base}/{id}`],
      ["PATCH", `${base}/{id}`],
      ["DELETE", `${base}/{id}`],
    ];
    for (const [method, path] of apiRoutes) {
      routes.push({ method, path, file: filePath, tags, framework: "laravel", params: extractPathParams(path), confidence: "regex" });
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

// ─── Eloquent model extraction ─────────────────────────────────────────────

const ELOQUENT_RELATIONS = ["hasMany", "hasOne", "belongsTo", "belongsToMany", "hasManyThrough", "hasOneThrough", "morphTo", "morphMany", "morphOne"];
const AUDIT_FIELDS = new Set(["created_at", "updated_at", "deleted_at", "createdAt", "updatedAt", "deletedAt"]);

export function extractEloquentModels(
  _filePath: string,
  content: string
): SchemaModel[] {
  const models: SchemaModel[] = [];

  // class ModelName extends Model (or extends \Illuminate\Database\Eloquent\Model)
  const classPattern = /class\s+(\w+)\s+extends\s+(?:\\?[\w\\]+\\)?Model\b/g;
  let m: RegExpExecArray | null;
  while ((m = classPattern.exec(content)) !== null) {
    const name = m[1];
    const fields: SchemaField[] = [];
    const relations: string[] = [];

    // $fillable = ['field1', 'field2', ...]
    const fillableMatch = content.match(/\$fillable\s*=\s*\[([^\]]+)\]/);
    if (fillableMatch) {
      const items = fillableMatch[1].match(/['"]([^'"]+)['"]/g) ?? [];
      for (const item of items) {
        const fieldName = item.replace(/['"]/g, "");
        if (AUDIT_FIELDS.has(fieldName)) continue;
        // Infer type from name heuristics
        let type = "string";
        if (fieldName.endsWith("_id") || fieldName === "id") type = "integer";
        else if (fieldName.startsWith("is_") || fieldName.startsWith("has_")) type = "boolean";
        else if (fieldName.includes("_at") || fieldName.includes("date") || fieldName.includes("time")) type = "timestamp";
        else if (fieldName === "amount" || fieldName === "price" || fieldName === "total") type = "decimal";

        const flags: string[] = [];
        if (fieldName === "id") flags.push("pk");
        if (fieldName.endsWith("_id") && fieldName !== "id") flags.push("fk");

        fields.push({ name: fieldName, type, flags });
      }
    }

    // $casts = ['field' => 'type'] for additional type info
    const castsMatch = content.match(/\$casts\s*=\s*\[([^\]]+)\]/s);
    if (castsMatch) {
      const castPairs = castsMatch[1].matchAll(/['"]([^'"]+)['"]\s*=>\s*['"]([^'"]+)['"]/g);
      for (const pair of castPairs) {
        const fieldName = pair[1];
        const castType = pair[2];
        if (AUDIT_FIELDS.has(fieldName)) continue;
        const existing = fields.find((f) => f.name === fieldName);
        if (existing) {
          existing.type = castType;
        } else {
          fields.push({ name: fieldName, type: castType, flags: [] });
        }
      }
    }

    // Relationship methods
    for (const rel of ELOQUENT_RELATIONS) {
      const relPattern = new RegExp(
        `function\\s+(\\w+)\\s*\\(\\s*\\)[^{]*\\{[^}]*return\\s+\\$this->${rel}\\s*\\(\\s*([\\w:]+)`,
        "g"
      );
      let relMatch: RegExpExecArray | null;
      while ((relMatch = relPattern.exec(content)) !== null) {
        const methodName = relMatch[1];
        const relatedModel = relMatch[2].replace(/.*::class/, "").replace(/::/g, "");
        relations.push(`${methodName}: ${rel}(${relatedModel})`);
      }
    }

    models.push({ name, fields, relations, orm: "eloquent" });
  }

  return models;
}

// ─── PHP lib exports ───────────────────────────────────────────────────────

export function extractPhpExports(content: string): ExportItem[] {
  const exports: ExportItem[] = [];

  // class/interface/trait/enum ClassName
  const typePattern = /(?:^|\n)\s*(?:abstract\s+|final\s+)?(?:(class|interface|trait|enum))\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = typePattern.exec(content)) !== null) {
    const kind = m[1] === "interface" ? "interface" : m[1] === "enum" ? "enum" : "class";
    exports.push({ name: m[2], kind });
  }

  // public function methodName(
  const methodPattern = /public\s+(?:static\s+)?function\s+(\w+)\s*\(/g;
  while ((m = methodPattern.exec(content)) !== null) {
    if (!exports.some((e) => e.name === m![1])) {
      exports.push({ name: m[1], kind: "function" });
    }
  }

  return exports;
}

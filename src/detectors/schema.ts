import { join, relative } from "node:path";
import { readFileSafe } from "../scanner.js";
import { loadTypeScript } from "../ast/loader.js";
import { extractDrizzleSchemaAST, extractTypeORMSchemaAST } from "../ast/extract-schema.js";
import { extractSQLAlchemyAST, extractDjangoModelsAST } from "../ast/extract-python.js";
import { extractGORMModelsStructured } from "../ast/extract-go.js";
import { extractEloquentModels } from "../ast/extract-php.js";
import { extractEntityFrameworkModels } from "../ast/extract-csharp.js";
import type { SchemaModel, SchemaField, ProjectInfo } from "../types.js";

const AUDIT_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "deletedAt",
  "created_at",
  "updated_at",
  "deleted_at",
]);

export async function detectSchemas(
  files: string[],
  project: ProjectInfo
): Promise<SchemaModel[]> {
  const models: SchemaModel[] = [];

  for (const orm of project.orms) {
    switch (orm) {
      case "drizzle":
        models.push(...(await detectDrizzleSchemas(files, project)));
        break;
      case "prisma":
        models.push(...(await detectPrismaSchemas(files, project)));
        break;
      case "typeorm":
        models.push(...(await detectTypeORMSchemas(files, project)));
        break;
      case "sqlalchemy":
        models.push(...(await detectSQLAlchemySchemas(files, project)));
        break;
      case "gorm":
        models.push(...(await detectGORMSchemas(files, project)));
        break;
      case "django":
        models.push(...(await detectDjangoSchemas(files, project)));
        break;
      case "eloquent":
        models.push(...(await detectEloquentSchemas(files, project)));
        break;
      case "entity-framework":
        models.push(...(await detectEntityFrameworkSchemas(files, project)));
        break;
    }
  }

  return models;
}

// --- Drizzle ORM ---
async function detectDrizzleSchemas(
  files: string[],
  project: ProjectInfo
): Promise<SchemaModel[]> {
  const schemaFiles = files.filter(
    (f) =>
      f.match(/schema\.(ts|js)$/) ||
      f.match(/\/schema\/.*\.(ts|js)$/) ||
      f.match(/\.schema\.(ts|js)$/) ||
      f.match(/\/db\/.*\.(ts|js)$/)
  );

  const models: SchemaModel[] = [];
  const ts = loadTypeScript(project.root);

  for (const file of schemaFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("pgTable") && !content.includes("mysqlTable") && !content.includes("sqliteTable")) continue;

    // Try AST first — much more accurate for Drizzle field chains
    if (ts) {
      const astModels = extractDrizzleSchemaAST(ts, file, content);
      if (astModels.length > 0) {
        models.push(...astModels);
        continue;
      }
    }

    // Match: export const users = pgTable("users", { ... })
    const tablePattern =
      /(?:export\s+)?const\s+(\w+)\s*=\s*(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"`](\w+)['"`]\s*,\s*(?:\(\s*\)\s*=>\s*\(?\s*)?\{([\s\S]*?)\}\s*\)?\s*(?:,|\))/g;

    let match;
    while ((match = tablePattern.exec(content)) !== null) {
      const tableName = match[2];
      const body = match[3];

      const fields: SchemaField[] = [];
      const relations: string[] = [];

      // Parse fields: fieldName: dataType("col").flags()
      const fieldPattern =
        /(\w+)\s*:\s*([\w.]+)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)([^,\n]*)/g;
      let fieldMatch;
      while ((fieldMatch = fieldPattern.exec(body)) !== null) {
        const name = fieldMatch[1];
        if (AUDIT_FIELDS.has(name)) continue;

        const type = fieldMatch[2].replace(/.*\./, ""); // remove prefix like t.
        const chain = fieldMatch[4] || "";
        const flags: string[] = [];

        if (chain.includes("primaryKey")) flags.push("pk");
        if (chain.includes("unique")) flags.push("unique");
        if (chain.includes("notNull")) flags.push("required");
        if (chain.includes("default")) flags.push("default");
        if (chain.includes("references")) {
          flags.push("fk");
          const refMatch = chain.match(/references\s*\(\s*\(\s*\)\s*=>\s*(\w+)\.(\w+)/);
          if (refMatch) relations.push(`${name} -> ${refMatch[1]}.${refMatch[2]}`);
        }
        if (name.endsWith("Id") || name.endsWith("_id")) {
          if (!flags.includes("fk")) flags.push("fk");
        }

        fields.push({ name, type, flags });
      }

      if (fields.length > 0) {
        models.push({
          name: tableName,
          fields,
          relations,
          orm: "drizzle",
        });
      }
    }

    // Also detect Drizzle relations
    const relPattern =
      /relations\s*\(\s*(\w+)\s*,\s*\(\s*\{([^}]+)\}\s*\)\s*=>\s*\(?\s*\{([\s\S]*?)\}\s*\)?\s*\)/g;
    let relMatch;
    while ((relMatch = relPattern.exec(content)) !== null) {
      const tableName = relMatch[1];
      const relBody = relMatch[3];
      const model = models.find((m) => m.name === tableName);
      if (!model) continue;

      const relEntries =
        /(\w+)\s*:\s*(one|many)\s*\(\s*(\w+)/g;
      let entry;
      while ((entry = relEntries.exec(relBody)) !== null) {
        model.relations.push(`${entry[1]}: ${entry[2]}(${entry[3]})`);
      }
    }
  }

  return models;
}

// --- Prisma ---
async function detectPrismaSchemas(
  _files: string[],
  project: ProjectInfo
): Promise<SchemaModel[]> {
  // Collect all candidate paths: standard root locations + workspace sub-paths (monorepo)
  const candidateSet = new Set<string>([
    join(project.root, "prisma/schema.prisma"),
    join(project.root, "schema.prisma"),
    join(project.root, "prisma/schema"),
  ]);
  // Check each workspace directory for its own schema.prisma (handles monorepos)
  for (const ws of project.workspaces) {
    const wsAbs = join(project.root, ws.path);
    candidateSet.add(join(wsAbs, "schema.prisma"));
    candidateSet.add(join(wsAbs, "prisma/schema.prisma"));
    candidateSet.add(join(wsAbs, "prisma/schema"));
  }

  const allModels: SchemaModel[] = [];
  const seenNames = new Set<string>();

  for (const p of candidateSet) {
    const content = await readFileSafe(p);
    if (!content) continue;

    const modelPattern = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
    let match;
    while ((match = modelPattern.exec(content)) !== null) {
      const name = match[1];
      if (seenNames.has(name)) continue;
      const body = match[2];
      const fields: SchemaField[] = [];
      const relations: string[] = [];

      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@")) continue;

        const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\?|\[\])?\s*(.*)/);
        if (!fieldMatch) continue;

        const [, fieldName, fieldType, modifier, rest] = fieldMatch;
        if (AUDIT_FIELDS.has(fieldName)) continue;

        if (rest.includes("@relation")) {
          relations.push(`${fieldName}: ${fieldType}${modifier || ""}`);
          continue;
        }
        if (modifier === "[]") {
          relations.push(`${fieldName}: ${fieldType}[]`);
          continue;
        }

        const flags: string[] = [];
        if (rest.includes("@id")) flags.push("pk");
        if (rest.includes("@unique")) flags.push("unique");
        if (rest.includes("@default")) flags.push("default");
        if (modifier === "?") flags.push("nullable");
        if (fieldName.endsWith("Id") || fieldName.endsWith("_id")) flags.push("fk");

        fields.push({ name: fieldName, type: fieldType, flags });
      }

      if (fields.length > 0) {
        seenNames.add(name);
        allModels.push({ name, fields, relations, orm: "prisma" });
      }
    }

    // Also detect enums
    const enumPattern = /enum\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
    while ((match = enumPattern.exec(content)) !== null) {
      const enumKey = `enum:${match[1]}`;
      if (seenNames.has(enumKey)) continue;
      const values = match[2]
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("//"));
      seenNames.add(enumKey);
      allModels.push({
        name: enumKey,
        fields: values.map((v) => ({ name: v, type: "enum", flags: [] })),
        relations: [],
        orm: "prisma",
      });
    }
  }

  return allModels;
}

// --- TypeORM ---
async function detectTypeORMSchemas(
  files: string[],
  project: ProjectInfo
): Promise<SchemaModel[]> {
  const entityFiles = files.filter(
    (f) => f.match(/\.entity\.(ts|js)$/) || f.match(/entities\/.*\.(ts|js)$/)
  );
  const models: SchemaModel[] = [];
  const ts = loadTypeScript(project.root);

  for (const file of entityFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("@Entity") && !content.includes("@Column")) continue;

    // Try AST first — handles TypeORM decorators accurately
    if (ts) {
      const astModels = extractTypeORMSchemaAST(ts, file, content);
      if (astModels.length > 0) {
        models.push(...astModels);
        continue;
      }
    }

    // Extract entity name
    const entityMatch = content.match(/@Entity\s*\(\s*(?:['"`](\w+)['"`])?\s*\)/);
    const classMatch = content.match(/class\s+(\w+)/);
    const name = entityMatch?.[1] || classMatch?.[1] || "Unknown";

    const fields: SchemaField[] = [];
    const relations: string[] = [];

    // Match columns
    const colPattern =
      /@(?:PrimaryGeneratedColumn|PrimaryColumn|Column|CreateDateColumn|UpdateDateColumn)\s*\(([^)]*)\)\s*\n\s*(\w+)\s*[!?]?\s*:\s*(\w+)/g;
    let match;
    while ((match = colPattern.exec(content)) !== null) {
      const decorator = match[0];
      const fieldName = match[2];
      const fieldType = match[3];
      if (AUDIT_FIELDS.has(fieldName)) continue;

      const flags: string[] = [];
      if (decorator.includes("PrimaryGeneratedColumn") || decorator.includes("PrimaryColumn"))
        flags.push("pk");
      if (decorator.includes("unique: true")) flags.push("unique");
      if (decorator.includes("nullable: true")) flags.push("nullable");
      if (decorator.includes("default:")) flags.push("default");

      fields.push({ name: fieldName, type: fieldType, flags });
    }

    // Match relations
    const relPattern =
      /@(?:OneToMany|ManyToOne|OneToOne|ManyToMany)\s*\([^)]*\)\s*\n\s*(\w+)\s*[!?]?\s*:\s*(\w+)/g;
    while ((match = relPattern.exec(content)) !== null) {
      relations.push(`${match[1]}: ${match[2]}`);
    }

    if (fields.length > 0) {
      models.push({ name, fields, relations, orm: "typeorm" });
    }
  }

  return models;
}

// --- SQLAlchemy ---
async function detectSQLAlchemySchemas(
  files: string[],
  project: ProjectInfo
): Promise<SchemaModel[]> {
  const pyFiles = files.filter((f) => f.endsWith(".py"));
  const models: SchemaModel[] = [];

  for (const file of pyFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("Column") && !content.includes("mapped_column")) continue;
    if (!content.includes("Base") && !content.includes("DeclarativeBase") && !content.includes("Model")) continue;

    const rel = relative(project.root, file);

    // Try Python AST first
    const astModels = await extractSQLAlchemyAST(rel, content);
    if (astModels && astModels.length > 0) {
      models.push(...astModels);
      continue;
    }

    // Fallback to regex
    const classPattern =
      /class\s+(\w+)\s*\([^)]*(?:Base|Model|DeclarativeBase)[^)]*\)\s*:([\s\S]*?)(?=\nclass\s|\n[^\s]|$)/g;
    let match;
    while ((match = classPattern.exec(content)) !== null) {
      const name = match[1];
      const body = match[2];
      const fields: SchemaField[] = [];
      const relations: string[] = [];

      // Match Column definitions
      const colPattern =
        /(\w+)\s*(?::\s*Mapped\[([^\]]+)\]\s*=\s*mapped_column|=\s*(?:db\.)?Column)\s*\(([^)]*)\)/g;
      let colMatch;
      while ((colMatch = colPattern.exec(body)) !== null) {
        const fieldName = colMatch[1];
        if (AUDIT_FIELDS.has(fieldName)) continue;
        const mappedType = colMatch[2] || "";
        const args = colMatch[3];

        const flags: string[] = [];
        if (args.includes("primary_key=True")) flags.push("pk");
        if (args.includes("unique=True")) flags.push("unique");
        if (args.includes("nullable=True")) flags.push("nullable");
        if (args.includes("ForeignKey")) flags.push("fk");
        if (args.includes("default=")) flags.push("default");

        const typeMatch = args.match(/(?:String|Integer|Boolean|Float|Text|DateTime|JSON|UUID)/);
        const type = mappedType || typeMatch?.[0] || "unknown";

        fields.push({ name: fieldName, type, flags });
      }

      // Match relationship
      const relPattern = /(\w+)\s*=\s*relationship\s*\(\s*['"](\w+)['"]/g;
      let relMatch;
      while ((relMatch = relPattern.exec(body)) !== null) {
        relations.push(`${relMatch[1]}: ${relMatch[2]}`);
      }

      if (fields.length > 0) {
        models.push({ name, fields, relations, orm: "sqlalchemy" });
      }
    }
  }

  return models;
}

// --- GORM ---
async function detectGORMSchemas(
  files: string[],
  _project: ProjectInfo
): Promise<SchemaModel[]> {
  const goFiles = files.filter((f) => f.endsWith(".go"));
  const models: SchemaModel[] = [];

  for (const file of goFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("gorm") && !content.includes("Model") && !content.includes("`json:")) continue;

    const rel = relative(_project.root, file);
    const structModels = extractGORMModelsStructured(rel, content);
    models.push(...structModels);
  }

  return models;
}

// --- Django ORM ---
async function detectDjangoSchemas(
  files: string[],
  project: ProjectInfo
): Promise<SchemaModel[]> {
  // Django models live in models.py or models/ directories
  const modelFiles = files.filter(
    (f) => f.endsWith("/models.py") || f.includes("/models/") && f.endsWith(".py")
  );
  const models: SchemaModel[] = [];

  for (const file of modelFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("models.Model") && !content.includes("(Model)")) continue;

    const rel = relative(project.root, file);
    const astModels = await extractDjangoModelsAST(rel, content);
    if (astModels && astModels.length > 0) {
      models.push(...astModels);
      continue;
    }

    // Regex fallback
    const classPattern = /class\s+(\w+)\s*\(\s*(?:\w+\.)?Model\s*\)\s*:/g;
    let m: RegExpExecArray | null;
    while ((m = classPattern.exec(content)) !== null) {
      const name = m[1];
      if (name === "Meta") continue;
      const fields: SchemaField[] = [];
      const relations: string[] = [];

      // Match field assignments after the class definition
      const classStart = m.index + m[0].length;
      const nextClassMatch = /\nclass\s+\w+/.exec(content.slice(classStart));
      const classBody = nextClassMatch
        ? content.slice(classStart, classStart + nextClassMatch.index)
        : content.slice(classStart);

      const fieldPat = /^\s{4}(\w+)\s*=\s*(?:models\.)?(CharField|TextField|EmailField|IntegerField|BigIntegerField|FloatField|DecimalField|BooleanField|DateField|DateTimeField|TimeField|JSONField|UUIDField|AutoField|BigAutoField|PositiveIntegerField|SlugField|URLField|FileField|ImageField|ForeignKey|OneToOneField|ManyToManyField)\s*\(/gm;
      let fm: RegExpExecArray | null;
      while ((fm = fieldPat.exec(classBody)) !== null) {
        const fname = fm[1];
        const fclass = fm[2];
        if (AUDIT_FIELDS.has(fname)) continue;

        if (fclass === "ForeignKey" || fclass === "OneToOneField") {
          relations.push(`${fname}: ${fclass}`);
          fields.push({ name: fname + "_id", type: "integer", flags: ["fk"] });
        } else if (fclass === "ManyToManyField") {
          relations.push(`${fname}: ManyToMany`);
        } else {
          const typeMap: Record<string, string> = {
            CharField: "string", TextField: "string", EmailField: "string",
            SlugField: "string", URLField: "string", FileField: "string", ImageField: "string",
            IntegerField: "integer", BigIntegerField: "integer", PositiveIntegerField: "integer",
            AutoField: "integer", BigAutoField: "integer",
            FloatField: "float", DecimalField: "decimal",
            BooleanField: "boolean", DateField: "date", DateTimeField: "timestamp",
            TimeField: "time", JSONField: "json", UUIDField: "uuid",
          };
          fields.push({ name: fname, type: typeMap[fclass] ?? "string", flags: [] });
        }
      }

      if (fields.length > 0 || relations.length > 0) {
        models.push({ name, fields, relations, orm: "django" });
      }
    }
  }

  return models;
}

// --- Eloquent (Laravel) ---
async function detectEloquentSchemas(
  files: string[],
  project: ProjectInfo
): Promise<SchemaModel[]> {
  const phpFiles = files.filter((f) => f.endsWith(".php"));
  const models: SchemaModel[] = [];

  for (const file of phpFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("extends") || !content.includes("Model")) continue;
    // Require at least one Eloquent-specific marker to avoid XML/ViewModel false positives
    const hasEloquentMarker =
      content.includes("Illuminate\\Database\\Eloquent") ||
      content.includes("$fillable") ||
      content.includes("$table") ||
      content.includes("$this->hasMany") ||
      content.includes("$this->belongsTo") ||
      content.includes("$this->hasOne") ||
      content.includes("$this->belongsToMany");
    if (!hasEloquentMarker) continue;
    const rel = relative(project.root, file);
    models.push(...extractEloquentModels(rel, content));
  }

  return models;
}

// --- Entity Framework (ASP.NET) ---
async function detectEntityFrameworkSchemas(
  files: string[],
  project: ProjectInfo
): Promise<SchemaModel[]> {
  const csFiles = files.filter((f) => f.endsWith(".cs"));
  const models: SchemaModel[] = [];

  for (const file of csFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("DbContext") && !content.includes("DbSet<")) continue;
    const rel = relative(project.root, file);
    models.push(...extractEntityFrameworkModels(rel, content));
  }

  return models;
}

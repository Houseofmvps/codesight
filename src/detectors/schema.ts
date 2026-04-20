import { join, relative } from "node:path";
import { readFileSafe } from "../scanner.js";
import { loadTypeScript } from "../ast/loader.js";
import { extractDrizzleSchemaAST, extractTypeORMSchemaAST } from "../ast/extract-schema.js";
import { extractSQLAlchemyAST, extractDjangoModelsAST, extractSQLModelAST } from "../ast/extract-python.js";
import { extractGORMModelsStructured, extractEntSchemasStructured } from "../ast/extract-go.js";
import { extractEloquentModels } from "../ast/extract-php.js";
import { extractEntityFrameworkModels } from "../ast/extract-csharp.js";
import { extractRoomEntities } from "../ast/extract-android.js";
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
      case "ent":
        models.push(...(await detectEntSchemas(files, project)));
        break;
      case "activerecord":
        models.push(...(await detectActiveRecordSchemas(project)));
        break;
      case "ecto":
        models.push(...(await detectEctoSchemas(files, project)));
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
      case "mongoose":
        models.push(...(await detectMongooseSchemas(files, project)));
        break;
      case "sequelize":
        models.push(...(await detectSequelizeSchemas(files, project)));
        break;
      case "exposed":
        models.push(...(await detectExposedSchemas(files, project)));
        break;
      case "room":
        models.push(...(await detectRoomSchemas(files, project)));
        break;
      case "scenegraph":
        models.push(...(await detectSceneGraphSchemas(files, project)));
        break;
    }
  }

  // Raw SQL migrations — detect CREATE TABLE when no ORM covers it
  const ormNames = new Set(project.orms);
  const hasSchemaORM = ormNames.size > 0 && !ormNames.has("unknown");
  if (!hasSchemaORM || models.length === 0) {
    const sqlModels = await detectRawSQLSchemas(files, project);
    // Only add if not already covered by ORM detection
    const existingNames = new Set(models.map((m) => m.name.toLowerCase()));
    for (const m of sqlModels) {
      if (!existingNames.has(m.name.toLowerCase())) models.push(m);
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
    const rel = relative(project.root, file);

    // SQLModel: class X(SQLModel, table=True) with typed annotations
    if (content.includes("SQLModel") && content.includes("table=True")) {
      const sqlmodelModels = await extractSQLModelAST(rel, content);
      if (sqlmodelModels && sqlmodelModels.length > 0) {
        models.push(...sqlmodelModels);
        continue;
      }
    }

    if (!content.includes("Column") && !content.includes("mapped_column")) continue;
    if (!content.includes("Base") && !content.includes("DeclarativeBase") && !content.includes("Model")) continue;

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

// --- Ent (Go) ---
async function detectEntSchemas(
  files: string[],
  _project: ProjectInfo
): Promise<SchemaModel[]> {
  const goFiles = files.filter(
    (f) => f.endsWith(".go") && (f.includes("/ent/schema/") || f.includes("/schema/"))
  );
  const models: SchemaModel[] = [];

  for (const file of goFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("ent.Schema")) continue;

    const rel = relative(_project.root, file);
    const structModels = extractEntSchemasStructured(rel, content);
    models.push(...structModels);
  }

  return models;
}

// --- Ecto (Phoenix/Elixir) ---
async function detectEctoSchemas(
  files: string[],
  _project: ProjectInfo
): Promise<SchemaModel[]> {
  const exFiles = files.filter((f) => f.endsWith(".ex") || f.endsWith(".exs"));
  const models: SchemaModel[] = [];

  for (const file of exFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("use Ecto.Schema") && !content.includes("Ecto.Schema")) continue;

    // schema "table_name" do ... end
    const schemaPattern = /schema\s+["'](\w+)["']\s+do([\s\S]*?)(?:\n\s*end\b)/g;
    let m: RegExpExecArray | null;
    while ((m = schemaPattern.exec(content)) !== null) {
      const tableName = m[1];
      const body = m[2];
      const fields: SchemaField[] = [];
      const relations: string[] = [];

      // field :name, :type (or :type with options)
      const fieldPat = /field\s+:(\w+),\s*(?::(\w+)|[\w.]+\.(\w+))/g;
      let fm: RegExpExecArray | null;
      while ((fm = fieldPat.exec(body)) !== null) {
        const fname = fm[1];
        const ftype = fm[2] || fm[3] || "unknown";
        if (AUDIT_FIELDS.has(fname) || fname === "inserted_at" || fname === "updated_at") continue;

        const ectoTypeMap: Record<string, string> = {
          string: "string", binary: "bytes", boolean: "boolean",
          integer: "integer", float: "float", decimal: "decimal",
          date: "date", time: "time", naive_datetime: "timestamp",
          utc_datetime: "timestamp", datetime: "timestamp",
          map: "map", array: "array", uuid: "uuid",
          binary_id: "uuid", id: "integer",
          Enum: "enum", INET: "inet",
        };

        const flags: string[] = [];
        if (fname.endsWith("_id")) flags.push("fk");
        fields.push({ name: fname, type: ectoTypeMap[ftype] ?? ftype, flags });
      }

      // belongs_to :name, Module
      const belongsPat = /belongs_to\s+:(\w+),\s*(\w[\w.]*)/g;
      while ((fm = belongsPat.exec(body)) !== null) {
        relations.push(`${fm[1]}: belongs_to(${fm[2]})`);
        fields.push({ name: fm[1] + "_id", type: "integer", flags: ["fk"] });
      }

      // has_many / has_one / many_to_many
      const hasPat = /(has_many|has_one|many_to_many)\s+:(\w+),\s*(\w[\w.]*)/g;
      while ((fm = hasPat.exec(body)) !== null) {
        relations.push(`${fm[2]}: ${fm[1]}(${fm[3]})`);
      }

      if (fields.length > 0 || relations.length > 0) {
        // Use module name as model name if available
        const modMatch = content.match(/defmodule\s+([\w.]+)/);
        const modelName = modMatch ? modMatch[1].split(".").pop()! : tableName;
        models.push({ name: modelName, fields, relations, orm: "ecto" });
      }
    }
  }

  return models;
}

// --- ActiveRecord (Rails) — parse db/schema.rb ---
async function detectActiveRecordSchemas(
  project: ProjectInfo
): Promise<SchemaModel[]> {
  const schemaPath = join(project.root, "db/schema.rb");
  const content = await readFileSafe(schemaPath);
  if (!content) return [];

  const models: SchemaModel[] = [];
  // create_table "tablename", options... do |t| ... end
  const tablePattern = /create_table\s+["'](\w+)["'][^\n]*\bdo\s*\|t\|([\s\S]*?)^\s*end/gm;
  let m: RegExpExecArray | null;

  while ((m = tablePattern.exec(content)) !== null) {
    const name = m[1];
    const body = m[2];
    const fields: SchemaField[] = [];
    const relations: string[] = [];

    // t.type "column_name" ...
    const fieldPat = /t\.(\w+)\s+["'](\w+)["']([^\n]*)/g;
    let fm: RegExpExecArray | null;
    while ((fm = fieldPat.exec(body)) !== null) {
      const rbType = fm[1];
      const fieldName = fm[2];
      const opts = fm[3];

      // Skip index and metadata entries
      if (["index", "timestamps", "primary_key"].includes(rbType)) continue;
      if (AUDIT_FIELDS.has(fieldName)) continue;

      const typeMap: Record<string, string> = {
        string: "string", text: "text", citext: "string",
        integer: "integer", bigint: "integer", smallint: "integer",
        float: "float", decimal: "decimal", numeric: "decimal",
        boolean: "boolean",
        date: "date", datetime: "timestamp", timestamp: "timestamp", time: "time",
        json: "json", jsonb: "jsonb",
        uuid: "uuid", binary: "bytes",
        inet: "string", ltree: "string",
      };

      const flags: string[] = [];
      if (opts.includes("null: false")) flags.push("required");
      if (opts.includes("default:")) flags.push("default");
      if (fieldName.endsWith("_id")) { flags.push("fk"); relations.push(`${fieldName} -> ?`); }

      fields.push({ name: fieldName, type: typeMap[rbType] ?? rbType, flags });
    }

    if (fields.length > 0) {
      models.push({ name, fields, relations, orm: "activerecord" });
    }
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

// --- Mongoose ---
async function detectMongooseSchemas(
  files: string[],
  _project: ProjectInfo
): Promise<SchemaModel[]> {
  const jstsFiles = files.filter((f) => f.match(/\.(js|ts|mjs|cjs)$/));
  const models: SchemaModel[] = [];
  const seenNames = new Set<string>();

  for (const file of jstsFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("mongoose") && !content.includes("Schema")) continue;

    // NestJS pattern: @Schema() + SchemaFactory.createForClass(XClass)
    if (content.includes("@Schema") && content.includes("SchemaFactory")) {
      const nestPat = /SchemaFactory\.createForClass\s*\(\s*(\w+)\s*\)/g;
      let nm: RegExpExecArray | null;
      while ((nm = nestPat.exec(content)) !== null) {
        // Model name = class name without "SchemaClass" / "Schema" / "Document" suffix
        const rawName = nm[1].replace(/(?:SchemaClass|Schema|Document)$/, "");
        const modelName = rawName || nm[1];
        if (seenNames.has(modelName)) continue;
        seenNames.add(modelName);

        const fields: SchemaField[] = [];
        // Extract @Prop() decorated fields with TypeScript types
        const propPat = /@Prop[^)]*\)\s*(?:readonly\s+)?(\w+)\??\s*:\s*([\w<>[\]|]+)/g;
        let pm: RegExpExecArray | null;
        while ((pm = propPat.exec(content)) !== null) {
          const name = pm[1];
          if (AUDIT_FIELDS.has(name)) continue;
          fields.push({ name, type: pm[2].toLowerCase(), flags: [] });
        }
        models.push({ name: modelName, fields, relations: [], orm: "mongoose" });
      }
      continue; // already handled this file
    }

    if (!content.includes("model(") && !content.includes(".model(")) continue;

    // mongoose.model('Name', schema) or model<IUser>('Name', schema)
    const modelPat = /(?:mongoose\.)?model\s*(?:<[^>]+>)?\s*\(\s*['"`]([A-Z]\w*)['"`]/g;
    let m: RegExpExecArray | null;

    while ((m = modelPat.exec(content)) !== null) {
      const modelName = m[1];
      if (seenNames.has(modelName)) continue;
      seenNames.add(modelName);

      const fields: SchemaField[] = [];
      const relations: string[] = [];

      // Find schema body: const XSchema = new (mongoose.)Schema({ ... })
      const candidates = [modelName + "Schema", modelName.toLowerCase() + "Schema", "schema", "Schema"];
      let schemaBody: string | null = null;
      for (const cand of candidates) {
        const varPat = new RegExp(
          `(?:const|let|var)\\s+${cand}\\s*=\\s*new\\s+(?:mongoose\\.)?Schema\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*[,)]`,
          "i"
        );
        const hit = varPat.exec(content);
        if (hit) { schemaBody = hit[1]; break; }
      }

      if (schemaBody) {
        const typeMap: Record<string, string> = {
          string: "string", number: "number", boolean: "boolean",
          date: "datetime", objectid: "string", buffer: "binary", mixed: "any", map: "map",
        };
        // fieldName: { type: String } or fieldName: String or fieldName: [String]
        const fieldPat = /^\s*(\w+)\s*:\s*(?:\{[^}]*\btype\s*:\s*(String|Number|Boolean|Date|ObjectId|Buffer|Mixed|Map)\b|\[\s*(String|Number|Boolean|Date|ObjectId|Buffer|Mixed)\s*\]|(String|Number|Boolean|Date|ObjectId|Buffer|Mixed)\b)/gm;
        let fm: RegExpExecArray | null;
        while ((fm = fieldPat.exec(schemaBody)) !== null) {
          const name = fm[1];
          if (["type", "default", "ref", "required", "unique", "index", "enum"].includes(name)) continue;
          if (AUDIT_FIELDS.has(name)) continue;
          const rawType = (fm[2] || fm[3] || fm[4] || "mixed").toLowerCase();
          fields.push({ name, type: typeMap[rawType] || rawType, flags: [] });
        }

        // ref: 'Model' → relation
        const refPat = /(\w+)\s*:\s*\{[^}]*ref\s*:\s*['"`](\w+)['"`]/g;
        while ((fm = refPat.exec(schemaBody)) !== null) {
          relations.push(`${fm[1]}: ${fm[2]}`);
        }
      }

      // Fallback: TypeScript interface IModelName extends Document
      if (fields.length === 0) {
        const ifacePat = new RegExp(
          `interface\\s+I${modelName}\\s*(?:extends[^{]+)?\\{([^}]+)\\}`, "s"
        );
        const ifaceMatch = content.match(ifacePat);
        if (ifaceMatch) {
          const fieldPat = /^\s*(\w+)\??\s*:\s*([\w<>[\]|' "]+)/gm;
          let fm: RegExpExecArray | null;
          while ((fm = fieldPat.exec(ifaceMatch[1])) !== null) {
            const name = fm[1];
            if (name.startsWith("_") || AUDIT_FIELDS.has(name)) continue;
            fields.push({ name, type: fm[2].trim(), flags: [] });
          }
        }
      }

      models.push({ name: modelName, fields, relations, orm: "mongoose" });
    }
  }

  return models;
}

// --- Sequelize ---
function parseSequelizeFields(body: string): SchemaField[] {
  const seqTypeMap: Record<string, string> = {
    STRING: "string", TEXT: "string", CHAR: "string", CITEXT: "string",
    INTEGER: "integer", BIGINT: "integer", SMALLINT: "integer",
    FLOAT: "float", DOUBLE: "float", REAL: "float",
    DECIMAL: "decimal", NUMERIC: "decimal",
    BOOLEAN: "boolean",
    DATE: "datetime", DATEONLY: "date", TIME: "time",
    JSON: "json", JSONB: "json",
    UUID: "string", UUIDV1: "string", UUIDV4: "string",
    BLOB: "binary", ARRAY: "array", ENUM: "enum", VIRTUAL: "virtual",
  };
  const skip = new Set(["type", "defaultValue", "allowNull", "unique", "primaryKey", "references", "onDelete", "onUpdate"]);
  const fields: SchemaField[] = [];
  // fieldName: DataTypes.STRING or fieldName: { type: DataTypes.INTEGER }
  const fieldPat = /^\s*(\w+)\s*:\s*(?:DataTypes?\.(\w+)|\{\s*(?:[^}]*\btype\s*:\s*DataTypes?\.(\w+)))/gm;
  let fm: RegExpExecArray | null;
  while ((fm = fieldPat.exec(body)) !== null) {
    const name = fm[1];
    if (skip.has(name) || AUDIT_FIELDS.has(name)) continue;
    const raw = (fm[2] || fm[3] || "unknown").toUpperCase();
    fields.push({ name, type: seqTypeMap[raw] || raw.toLowerCase(), flags: [] });
  }
  return fields;
}

async function detectSequelizeSchemas(
  files: string[],
  _project: ProjectInfo
): Promise<SchemaModel[]> {
  const jstsFiles = files.filter((f) => f.match(/\.(js|ts|mjs|cjs)$/));
  const models: SchemaModel[] = [];
  const seenNames = new Set<string>();

  for (const file of jstsFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("sequelize") && !content.includes("Sequelize") && !content.includes("DataTypes")) continue;

    // Pattern 1: class X extends Model with X.init({ fields }, { sequelize })
    const classInitPat = /class\s+(\w+)\s+extends\s+Model[\s\S]*?\1\.init\s*\(\s*\{([\s\S]*?)\}\s*,\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = classInitPat.exec(content)) !== null) {
      const name = m[1];
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      models.push({ name, fields: parseSequelizeFields(m[2]), relations: [], orm: "sequelize" });
    }

    // Pattern 2: sequelize.define('ModelName', { fields })
    const definePat = /sequelize\.define\s*\(\s*['"`](\w+)['"`]\s*,\s*\{([\s\S]*?)\}\s*[,)]/g;
    while ((m = definePat.exec(content)) !== null) {
      const name = m[1];
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      models.push({ name, fields: parseSequelizeFields(m[2]), relations: [], orm: "sequelize" });
    }
  }

  return models;
}

// --- Raw SQL migrations ---
const SQL_TYPE_MAP: Record<string, string> = {
  "serial": "integer(auto)", "bigserial": "bigint(auto)",
  "int": "integer", "integer": "integer", "bigint": "bigint", "smallint": "smallint",
  "text": "text", "varchar": "varchar", "char": "char", "character varying": "varchar",
  "boolean": "boolean", "bool": "boolean",
  "timestamp": "timestamp", "timestamptz": "timestamp(tz)", "date": "date", "time": "time",
  "uuid": "uuid", "json": "json", "jsonb": "jsonb",
  "float": "float", "real": "real", "double precision": "float8", "numeric": "numeric", "decimal": "decimal",
  "bytea": "bytes", "blob": "bytes",
};

// --- Exposed (Kotlin) ---
// Detects: object Users : Table() / IntIdTable() / LongIdTable() / UUIDTable()
// with column definitions: val name = varchar("name", 100)
async function detectExposedSchemas(
  files: string[],
  _project: ProjectInfo
): Promise<SchemaModel[]> {
  const ktFiles = files.filter((f) => f.endsWith(".kt"));
  const models: SchemaModel[] = [];

  const EXPOSED_TABLE_BASES = ["Table", "IntIdTable", "LongIdTable", "UUIDTable", "IdTable"];

  // Kotlin type map for Exposed column definitions
  const EXPOSED_TYPE_MAP: Record<string, string> = {
    integer: "integer", long: "bigint", short: "smallint",
    float: "float", double: "double", decimal: "decimal",
    varchar: "string", char: "char", text: "text",
    bool: "boolean", date: "date", datetime: "datetime",
    timestamp: "timestamp", binary: "bytes", blob: "bytes",
    uuid: "uuid", json: "json", jsonb: "json",
    reference: "integer", optReference: "integer",
  };

  for (const file of ktFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;
    if (!EXPOSED_TABLE_BASES.some((b) => content.includes(`: ${b}(`))) continue;

    // Match: object TableName : BaseTable(...) { ... }
    const objectPat = /object\s+(\w+)\s*:\s*(?:\w+\.)?(\w+)\s*\([^)]*\)\s*\{/g;
    let om: RegExpExecArray | null;

    while ((om = objectPat.exec(content)) !== null) {
      const name = om[1];
      const base = om[2];
      if (!EXPOSED_TABLE_BASES.includes(base)) continue;

      // Extract block after {
      const blockStart = om.index + om[0].length;
      let depth = 1;
      let i = blockStart;
      while (i < content.length && depth > 0) {
        if (content[i] === "{") depth++;
        else if (content[i] === "}") depth--;
        i++;
      }
      const block = content.slice(blockStart, i - 1);

      const fields: SchemaField[] = [];
      const relations: string[] = [];

      // val fieldName = typeFn("col_name", ...) — column definitions
      const colPat = /val\s+(\w+)\s*=\s*(\w+)\s*\(/g;
      let cm: RegExpExecArray | null;
      while ((cm = colPat.exec(block)) !== null) {
        const fieldName = cm[1];
        const typeFn = cm[2];
        if (fieldName === "primaryKey") continue; // override val primaryKey = PrimaryKey(...)

        const colType = EXPOSED_TYPE_MAP[typeFn] || typeFn.toLowerCase();
        const flags: string[] = [];

        // Check modifiers on the same line
        const lineEnd = block.indexOf("\n", cm.index);
        const line = block.slice(cm.index, lineEnd > -1 ? lineEnd : undefined);
        if (line.includes(".uniqueIndex()") || line.includes(".unique()")) flags.push("unique");
        if (line.includes(".nullable()")) flags.push("nullable");
        if (line.includes(".autoIncrement()")) flags.push("pk");
        if (typeFn === "reference" || typeFn === "optReference") {
          // Extract referenced table
          const refMatch = line.match(/reference\s*\(\s*"[^"]+"\s*,\s*(\w+)/);
          if (refMatch) {
            relations.push(`${fieldName}: ${refMatch[1]}`);
            flags.push("fk");
          }
        }

        fields.push({ name: fieldName, type: colType, flags });
      }

      if (fields.length > 0) {
        models.push({ name, fields, relations, orm: "exposed", confidence: "regex" });
      }
    }
  }

  return models;
}

async function detectRawSQLSchemas(
  files: string[],
  _project: ProjectInfo
): Promise<SchemaModel[]> {
  const sqlFiles = files.filter((f) => f.endsWith(".sql"));
  const models: SchemaModel[] = [];
  const seenNames = new Set<string>();

  for (const file of sqlFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;

    // CREATE TABLE [IF NOT EXISTS] schema.table_name ( ... )
    const createTablePat =
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[\w"]+\.)?\s*["']?([\w]+)["']?\s*\(([\s\S]*?)(?:\)\s*;|\)\s*\n)/gi;

    let m: RegExpExecArray | null;
    while ((m = createTablePat.exec(content)) !== null) {
      const tableName = m[1];
      if (seenNames.has(tableName.toLowerCase())) continue;
      if (tableName.toLowerCase().startsWith("pg_") || tableName.toLowerCase() === "schema_migrations") continue;
      seenNames.add(tableName.toLowerCase());

      const body = m[2];
      const fields: SchemaField[] = [];
      const relations: string[] = [];

      for (const rawLine of body.split(",")) {
        const line = rawLine.trim().replace(/--.*$/, "").trim();
        if (!line) continue;

        if (/^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT|INDEX)/i.test(line)) {
          const fkMatch = line.match(/FOREIGN\s+KEY\s*\((\w+)\)\s*REFERENCES\s+(\w+)\s*\((\w+)\)/i);
          if (fkMatch) relations.push(`${fkMatch[1]} -> ${fkMatch[2]}.${fkMatch[3]}`);
          continue;
        }

        const colMatch = line.match(/^["']?(\w+)["']?\s+([\w\s()]+?)(?:\s+(NOT\s+NULL|NULL|PRIMARY\s+KEY|UNIQUE|DEFAULT|REFERENCES|GENERATED)[\s\S]*)?$/i);
        if (!colMatch) continue;

        const colName = colMatch[1];
        if (["CONSTRAINT", "INDEX", "KEY", "UNIQUE", "CHECK", "PRIMARY"].includes(colName.toUpperCase())) continue;

        const rawType = colMatch[2].trim().toLowerCase().replace(/\s*\([^)]*\)/, "");
        const mappedType = SQL_TYPE_MAP[rawType] || rawType;
        const rest = colMatch[3] || "";

        const flags: string[] = [];
        if (/PRIMARY\s+KEY/i.test(rest) || /PRIMARY\s+KEY/i.test(line)) flags.push("pk");
        if (/NOT\s+NULL/i.test(rest)) flags.push("required");
        if (/UNIQUE/i.test(rest)) flags.push("unique");
        if (/DEFAULT/i.test(rest)) flags.push("default");
        if (/REFERENCES/i.test(rest)) {
          flags.push("fk");
          const refMatch = rest.match(/REFERENCES\s+(\w+)/i);
          if (refMatch) relations.push(`${colName} -> ${refMatch[1]}`);
        }
        if (colName.endsWith("_id") || colName.endsWith("Id")) {
          if (!flags.includes("fk")) flags.push("fk");
        }

        if (!AUDIT_FIELDS.has(colName)) {
          fields.push({ name: colName, type: mappedType, flags });
        }
      }

      if (fields.length > 0) {
        models.push({ name: tableName, fields, relations, orm: "unknown", confidence: "ast" });
      }
    }
  }

  return models;
}

// ─── Room (Android) ────────────────────────────────────────────────────────────

async function detectRoomSchemas(
  files: string[],
  project: ProjectInfo
): Promise<SchemaModel[]> {
  const ktFiles = files.filter((f) => f.endsWith(".kt"));
  const models: SchemaModel[] = [];

  for (const file of ktFiles) {
    const content = await readFileSafe(file);
    if (!content || !content.includes("@Entity")) continue;
    const rel = relative(project.root, file).replace(/\\/g, "/");
    models.push(...extractRoomEntities(rel, content));
  }

  return models;
}

// ─── SceneGraph schemas ───────────────────────────────────────────────────────
//
// Each SceneGraph component XML may declare an <interface> listing typed
// fields + functions that form the component's public contract. This is the
// closest Roku analog to an ORM model — a name + typed field set.
async function detectSceneGraphSchemas(
  files: string[],
  project: ProjectInfo
): Promise<SchemaModel[]> {
  const { extractSceneGraphComponent, isSceneGraphXml } = await import("../ast/extract-scenegraph.js");
  const xmlFiles = files.filter((f) => f.endsWith(".xml"));
  const models: SchemaModel[] = [];
  const seen = new Set<string>();

  for (const file of xmlFiles) {
    const content = await readFileSafe(file);
    if (!content || !isSceneGraphXml(content)) continue;
    const comp = extractSceneGraphComponent(content);
    if (!comp) continue;
    if (comp.interfaceFields.length === 0) continue;
    if (seen.has(comp.name)) continue;
    seen.add(comp.name);
    models.push({
      name: comp.name,
      fields: comp.interfaceFields,
      relations: [],
      orm: "scenegraph",
      confidence: "regex",
    });
  }

  return models;
}

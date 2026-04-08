/**
 * Python AST extraction via subprocess.
 * Spawns python3 with an inline script using stdlib `ast` module.
 * Zero dependencies — if the project uses Python, the interpreter is there.
 *
 * Extracts:
 * - FastAPI/Flask route decorators with precise path + method
 * - Django urlpatterns with path() calls
 * - SQLAlchemy model classes with Column types, flags, and relationships
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RouteInfo, SchemaModel, SchemaField, Framework } from "../types.js";

const execFileP = promisify(execFile);

// The Python script that does AST parsing via stdlib
// Outputs JSON to stdout
const PYTHON_ROUTE_SCRIPT = `
import ast, json, sys

def extract_routes(source, filename):
    try:
        tree = ast.parse(source, filename)
    except SyntaxError:
        return []

    routes = []

    for node in ast.walk(tree):
        # FastAPI/Flask style: @router.get("/path") or @app.route("/path", methods=["GET","POST"])
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for dec in node.decorator_list:
                route = parse_route_decorator(dec)
                if route:
                    for r in route:
                        routes.append(r)

        # Django: path("url", view) in urlpatterns list
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == 'urlpatterns':
                    if isinstance(node.value, (ast.List, ast.BinOp)):
                        routes.extend(parse_urlpatterns(node.value))

    return routes

def parse_route_decorator(dec):
    results = []

    # @router.get("/path") / @app.post("/path") — Attribute call
    if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute):
        method_name = dec.func.attr.upper()
        methods_map = {'GET':'GET','POST':'POST','PUT':'PUT','PATCH':'PATCH',
                       'DELETE':'DELETE','OPTIONS':'OPTIONS','HEAD':'HEAD'}

        if method_name in methods_map and dec.args:
            path = get_str(dec.args[0])
            if path is not None:
                results.append({'method': methods_map[method_name], 'path': path})

        # @app.route("/path", methods=["GET","POST"])
        if dec.func.attr == 'route' and dec.args:
            path = get_str(dec.args[0])
            if path is not None:
                methods = ['GET']
                for kw in dec.keywords:
                    if kw.arg == 'methods' and isinstance(kw.value, ast.List):
                        methods = [get_str(e) for e in kw.value.elts if get_str(e)]
                for m in methods:
                    results.append({'method': m.upper(), 'path': path})

    # @app.api_route("/path", methods=["GET","POST"]) — FastAPI api_route
    if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute):
        if dec.func.attr == 'api_route' and dec.args:
            path = get_str(dec.args[0])
            if path is not None:
                methods = ['GET']
                for kw in dec.keywords:
                    if kw.arg == 'methods' and isinstance(kw.value, ast.List):
                        methods = [get_str(e) for e in kw.value.elts if get_str(e)]
                for m in methods:
                    results.append({'method': m.upper(), 'path': path})

    return results if results else None

def parse_urlpatterns(node):
    routes = []
    elements = []
    if isinstance(node, ast.List):
        elements = node.elts
    elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        # urlpatterns = [...] + [...]
        if isinstance(node.left, ast.List):
            elements.extend(node.left.elts)
        if isinstance(node.right, ast.List):
            elements.extend(node.right.elts)

    for elt in elements:
        if isinstance(elt, ast.Call):
            func_name = ''
            if isinstance(elt.func, ast.Name):
                func_name = elt.func.id
            elif isinstance(elt.func, ast.Attribute):
                func_name = elt.func.attr

            if func_name in ('path', 're_path', 'url') and elt.args:
                path_str = get_str(elt.args[0])
                if path_str is not None:
                    routes.append({'method': 'ALL', 'path': '/' + path_str.lstrip('/')})

    return routes

def get_str(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Str):  # Python 3.7
        return node.s
    return None

source = sys.stdin.read()
filename = sys.argv[1] if len(sys.argv) > 1 else '<stdin>'
result = extract_routes(source, filename)
print(json.dumps(result))
`;

const PYTHON_SCHEMA_SCRIPT = `
import ast, json, sys

def extract_models(source, filename):
    try:
        tree = ast.parse(source, filename)
    except SyntaxError:
        return []

    models = []

    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue

        # Check if inherits from Base, Model, DeclarativeBase, db.Model
        is_model = False
        for base in node.bases:
            name = ''
            if isinstance(base, ast.Name):
                name = base.id
            elif isinstance(base, ast.Attribute):
                name = base.attr
            if name in ('Base', 'Model', 'DeclarativeBase', 'AbstractBase'):
                is_model = True
                break
        if not is_model:
            continue

        fields = []
        relations = []

        for item in node.body:
            # Column assignments: field = Column(Type, ...) or field: Mapped[Type] = mapped_column(...)
            if isinstance(item, ast.Assign):
                for target in item.targets:
                    if isinstance(target, ast.Name):
                        field_info = parse_column_or_rel(target.id, item.value)
                        if field_info:
                            if field_info['kind'] == 'field':
                                fields.append(field_info)
                            else:
                                relations.append(field_info)

            if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                field_name = item.target.id
                if field_name.startswith('__'):
                    continue
                if item.value:
                    field_info = parse_column_or_rel(field_name, item.value)
                    if field_info:
                        if field_info['kind'] == 'field':
                            # Try to get type from annotation
                            ann_type = extract_mapped_type(item.annotation)
                            if ann_type and field_info['type'] == 'unknown':
                                field_info['type'] = ann_type
                            fields.append(field_info)
                        else:
                            relations.append(field_info)

        if fields:
            models.append({
                'name': node.name,
                'fields': fields,
                'relations': relations,
            })

    return models

def parse_column_or_rel(name, value):
    if name.startswith('__'):
        return None

    # relationship("Model")
    if isinstance(value, ast.Call):
        func_name = get_func_name(value)

        if func_name in ('relationship', 'db.relationship'):
            target = ''
            if value.args:
                target = get_str(value.args[0]) or ''
            return {'kind': 'relation', 'name': name, 'target': target}

        if func_name in ('Column', 'db.Column', 'mapped_column'):
            col_type = 'unknown'
            flags = []

            for arg in value.args:
                t = get_type_name(arg)
                if t:
                    col_type = t
                if isinstance(arg, ast.Call) and get_func_name(arg) == 'ForeignKey':
                    flags.append('fk')

            for kw in value.keywords:
                if kw.arg == 'primary_key' and is_true(kw.value):
                    flags.append('pk')
                elif kw.arg == 'unique' and is_true(kw.value):
                    flags.append('unique')
                elif kw.arg == 'nullable' and is_true(kw.value):
                    flags.append('nullable')
                elif kw.arg == 'default':
                    flags.append('default')
                elif kw.arg == 'index' and is_true(kw.value):
                    flags.append('index')

            return {'kind': 'field', 'name': name, 'type': col_type, 'flags': flags}

    return None

def extract_mapped_type(annotation):
    # Mapped[int] or Mapped[Optional[str]]
    if isinstance(annotation, ast.Subscript):
        if isinstance(annotation.value, ast.Name) and annotation.value.id == 'Mapped':
            slice_node = annotation.slice
            if isinstance(slice_node, ast.Name):
                return slice_node.id
            if isinstance(slice_node, ast.Subscript) and isinstance(slice_node.value, ast.Name):
                if slice_node.value.id == 'Optional':
                    inner = slice_node.slice
                    if isinstance(inner, ast.Name):
                        return inner.id
    return None

def get_func_name(node):
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        if isinstance(node.func.value, ast.Name):
            return node.func.value.id + '.' + node.func.attr
        return node.func.attr
    return ''

def get_type_name(node):
    if isinstance(node, ast.Name):
        known = {'String','Integer','Boolean','Float','Text','DateTime','JSON',
                 'UUID','BigInteger','SmallInteger','Numeric','Date','Time',
                 'LargeBinary','Enum','ARRAY','JSONB'}
        if node.id in known:
            return node.id
    if isinstance(node, ast.Call):
        return get_type_name(node.func)
    if isinstance(node, ast.Attribute):
        return node.attr
    return None

def get_str(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None

def is_true(node):
    if isinstance(node, ast.Constant):
        return node.value is True
    if isinstance(node, ast.NameConstant):  # Python 3.7
        return node.value is True
    return False

source = sys.stdin.read()
filename = sys.argv[1] if len(sys.argv) > 1 else '<stdin>'
result = extract_models(source, filename)
print(json.dumps(result))
`;

const PYTHON_DJANGO_SCRIPT = `
import ast, json, sys

FIELD_TYPES = {
    'CharField': 'string', 'TextField': 'string', 'EmailField': 'string',
    'URLField': 'string', 'SlugField': 'string', 'FilePathField': 'string',
    'FileField': 'string', 'ImageField': 'string', 'IPAddressField': 'string',
    'GenericIPAddressField': 'string',
    'IntegerField': 'integer', 'SmallIntegerField': 'integer',
    'BigIntegerField': 'integer', 'PositiveIntegerField': 'integer',
    'PositiveSmallIntegerField': 'integer', 'AutoField': 'integer',
    'BigAutoField': 'integer', 'SmallAutoField': 'integer',
    'FloatField': 'float', 'DecimalField': 'decimal',
    'BooleanField': 'boolean', 'NullBooleanField': 'boolean',
    'DateField': 'date', 'DateTimeField': 'timestamp', 'TimeField': 'time',
    'DurationField': 'duration',
    'JSONField': 'json', 'UUIDField': 'uuid', 'BinaryField': 'bytes',
}
RELATION_FIELDS = {'ForeignKey', 'OneToOneField', 'ManyToManyField'}
AUDIT = {'created_at','updated_at','deleted_at','createdAt','updatedAt','deletedAt'}

def extract_django_models(source, filename):
    try:
        tree = ast.parse(source, filename)
    except SyntaxError:
        return []

    models = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        is_django = any(
            (isinstance(b, ast.Name) and b.id == 'Model') or
            (isinstance(b, ast.Attribute) and b.attr == 'Model')
            for b in node.bases
        )
        if not is_django:
            continue

        fields = []
        relations = []

        for item in node.body:
            if not isinstance(item, ast.Assign):
                continue
            for target in item.targets:
                if not isinstance(target, ast.Name):
                    continue
                fname = target.id
                if fname.startswith('_') or fname in AUDIT:
                    continue
                if not isinstance(item.value, ast.Call):
                    continue
                call = item.value
                fc = ''
                if isinstance(call.func, ast.Name):
                    fc = call.func.id
                elif isinstance(call.func, ast.Attribute):
                    fc = call.func.attr
                if not fc:
                    continue

                if fc in RELATION_FIELDS:
                    tgt = ''
                    if call.args:
                        a = call.args[0]
                        if isinstance(a, ast.Constant) and isinstance(a.value, str):
                            tgt = a.value.split('.')[-1]
                        elif isinstance(a, ast.Name):
                            tgt = a.id
                    rel_type = 'many' if fc == 'ManyToManyField' else 'one'
                    relations.append({'name': fname, 'target': tgt, 'type': rel_type})
                    if fc in ('ForeignKey', 'OneToOneField'):
                        fields.append({'name': fname + '_id', 'type': 'integer', 'flags': ['fk']})
                elif fc in FIELD_TYPES:
                    ftype = FIELD_TYPES[fc]
                    flags = []
                    for kw in call.keywords:
                        if kw.arg == 'primary_key' and isinstance(kw.value, ast.Constant) and kw.value.value:
                            flags.append('pk')
                        elif kw.arg == 'unique' and isinstance(kw.value, ast.Constant) and kw.value.value:
                            flags.append('unique')
                        elif kw.arg == 'null' and isinstance(kw.value, ast.Constant) and kw.value.value:
                            flags.append('nullable')
                        elif kw.arg == 'default':
                            flags.append('default')
                    fields.append({'name': fname, 'type': ftype, 'flags': flags})

        if fields or relations:
            models.append({'name': node.name, 'fields': fields, 'relations': relations})

    return models

source = sys.stdin.read()
filename = sys.argv[1] if len(sys.argv) > 1 else '<stdin>'
print(json.dumps(extract_django_models(source, filename)))
`;

let pythonAvailable: boolean | null = null;
let pythonCmd: string = "python3";

async function findPython(): Promise<boolean> {
  if (pythonAvailable !== null) return pythonAvailable;

  for (const cmd of ["python3", "python"]) {
    try {
      const { stdout } = await execFileP(cmd, ["--version"], { timeout: 3000 });
      if (stdout.includes("Python 3")) {
        pythonCmd = cmd;
        pythonAvailable = true;
        return true;
      }
    } catch {}
  }

  pythonAvailable = false;
  return false;
}

import { spawn } from "node:child_process";

async function runPythonWithStdin(script: string, source: string, filename: string): Promise<any> {
  if (!(await findPython())) return null;

  return new Promise((resolve) => {
    const proc = spawn(pythonCmd, ["-c", script, filename], {
      timeout: 10000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (code !== 0 || !stdout.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve(null);
      }
    });

    proc.on("error", () => resolve(null));

    proc.stdin.write(source);
    proc.stdin.end();
  });
}

/**
 * Extract routes from a Python file using AST.
 * Returns routes with confidence: "ast", or null if Python is unavailable.
 */
export async function extractPythonRoutesAST(
  filePath: string,
  content: string,
  framework: Framework,
  tags: string[]
): Promise<RouteInfo[] | null> {
  const result = await runPythonWithStdin(PYTHON_ROUTE_SCRIPT, content, filePath);
  if (!result || !Array.isArray(result) || result.length === 0) return null;

  return result.map((r: any) => ({
    method: r.method,
    path: r.path,
    file: filePath,
    tags,
    framework,
    params: extractPathParams(r.path),
    confidence: "ast" as const,
  }));
}

/**
 * Extract SQLAlchemy models from a Python file using AST.
 * Returns models with confidence: "ast", or null if Python is unavailable.
 */
export async function extractSQLAlchemyAST(
  filePath: string,
  content: string
): Promise<SchemaModel[] | null> {
  const result = await runPythonWithStdin(PYTHON_SCHEMA_SCRIPT, content, filePath);
  if (!result || !Array.isArray(result) || result.length === 0) return null;

  return result.map((m: any) => ({
    name: m.name,
    fields: (m.fields || []).map((f: any) => ({
      name: f.name,
      type: f.type || "unknown",
      flags: f.flags || [],
    })) as SchemaField[],
    relations: (m.relations || []).map((r: any) => `${r.name}: ${r.target}`),
    orm: "sqlalchemy" as const,
    confidence: "ast" as const,
  }));
}

/**
 * Extract Django ORM models from a Python file using AST.
 * Handles models.Model subclasses with CharField, ForeignKey, etc.
 */
export async function extractDjangoModelsAST(
  filePath: string,
  content: string
): Promise<SchemaModel[] | null> {
  const result = await runPythonWithStdin(PYTHON_DJANGO_SCRIPT, content, filePath);
  if (!result || !Array.isArray(result) || result.length === 0) return null;

  return result.map((m: any) => ({
    name: m.name,
    fields: (m.fields || []).map((f: any) => ({
      name: f.name,
      type: f.type || "unknown",
      flags: f.flags || [],
    })) as SchemaField[],
    relations: (m.relations || []).map((r: any) =>
      `${r.name}: ${r.type === "many" ? "many" : "one"}(${r.target})`
    ),
    orm: "django" as const,
    confidence: "ast" as const,
  }));
}

/**
 * Check if Python 3 is available on this system.
 */
export async function isPythonAvailable(): Promise<boolean> {
  return findPython();
}

function extractPathParams(path: string): string[] {
  const params: string[] = [];
  // FastAPI: {param} / Flask: <param> / Django: <type:param>
  const regex = /[{<](?:\w+:)?(\w+)[}>]/g;
  let m;
  while ((m = regex.exec(path)) !== null) params.push(m[1]);
  return params;
}

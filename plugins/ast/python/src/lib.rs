//! `codesight` plugin for Python AST parsing using Astral's [`ruff_python_ast`](ruff_python_ast).
//!
//! Implements the codesight WASM plugin ABI (see docs/wasm-plugins.md):
//!   alloc(len) -> ptr | dealloc(ptr, len)
//!   contractVersion() -> i32
//!   parseRoutes(srcPtr, srcLen) -> i64 (FastAPI/Flask decorators: @x.get("/p"), @app.route(...))
//!   parseSchemas(srcPtr, srcLen) -> i64 (model classes: annotated fields, Optional -> nullable)
//!   parseImports(srcPtr, srcLen) -> i64 (import / from-import targets)
//!
//! No imports (compiles for wasm32-unknown-unknown, panic = "abort").

#![allow(non_snake_case)]

use core::alloc::Layout as MemoryLayout;

use ruff_python_ast::{
    Arguments, Expr as Expression, ExprAttribute as AttributeExpression,
    ExprCall as CallExpression, ExprName as NameExpression, ExprStringLiteral as StringLiteral,
    Identifier, Stmt as Statement, StmtAnnAssign as AnnotationAssignment,
    StmtAssign as Assignment, StmtClassDef as ClassDef,
};
use ruff_python_parser::{Parsed, parse_module};

/// ABI contract version this plugin implements (must match the host's).
#[unsafe(no_mangle)]
pub extern "C" fn contractVersion() -> i32 {
    1
}

/// Self-description consumed by the host (languageId + extensions; frameworks carried).
#[unsafe(no_mangle)]
pub extern "C" fn describe() -> u64 {
    let meta = serde_json::json!({
        "languageId": "python",
        "extensions": [
            ".py",
        ],
        "frameworks": [
            "flask",
            "django",
            "fastapi",
            "sqlmodel",
            "pydantic",
            "sqlalchemy",
        ],
    });

    unsafe { report(meta.to_string().as_bytes()) }
}

// ─── ABI: memory ───

#[unsafe(no_mangle)]
pub extern "C" fn alloc(length: usize) -> *mut u8 {
    if length == 0 {
        return core::ptr::null_mut();
    }

    unsafe { std::alloc::alloc(MemoryLayout::from_size_align_unchecked(length, 1)) }
}

/// # Safety
/// `ptr`/`len` must come from a prior `alloc` call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(pointer: *mut u8, length: usize) {
    if pointer.is_null() || length == 0 {
        return;
    }

    unsafe {
        std::alloc::dealloc(pointer, MemoryLayout::from_size_align_unchecked(length, 1));
    }
}

// ─── ABI: per-kind parse entry points ───

/// # Safety
/// `src_ptr`/`src_len` describe a host-owned UTF-8 buffer (the host frees it).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parseRoutes(source: *const u8, length: usize) -> u64 {
    unsafe {
        parse_and_then(source, length, |body| {
            let mut routes = Vec::new();

            collect_routes(body, &mut routes);

            routes
        })
    }
}

/// # Safety
/// See [`parseRoutes`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parseSchemas(source: *const u8, length: usize) -> u64 {
    unsafe {
        parse_and_then(source, length, extract_schemas)
    }
}

/// # Safety
/// See [`parseRoutes`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parseImports(source: *const u8, length: usize) -> u64 {
    unsafe {
        parse_and_then(source, length, extract_imports)
    }
}

/// Decode UTF-8 source, parse with [`parse_module`], run `extract`, serialize, and
/// `report`. Returns 0 on invalid UTF-8, a syntax error, or an empty result (host
/// falls back).
unsafe fn parse_and_then<T: serde::Serialize>(
    source: *const u8,
    length: usize,
    extract: impl Fn(&[Statement]) -> Vec<T>,
) -> u64 {
    let bytes = unsafe {
        core::slice::from_raw_parts(source, length)
    };

    let Ok(source) = core::str::from_utf8(bytes) else {
        return 0;
    };

    let Ok(parsed) = parse_module(source).map(Parsed::into_syntax) else {
        return 0;
    };

    let Ok(extracted) = serde_json::to_string(&extract(&parsed.body)) else {
        return 0;
    };

    if extracted.is_empty()
        || extracted
            .split_ascii_whitespace()
            .collect::<Vec<_>>()
            .join("")
            == "[]"
    {
        return 0;
    }

    unsafe {
        report(extracted.as_bytes())
    }
}

/// Copy `bytes` into a fresh host-owned allocation and pack (ptr << 32) | len.
unsafe fn report(bytes: &[u8]) -> u64 {
    let length = bytes.len();
    let pointer = alloc(length);

    unsafe {
        core::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, length);
    }

    ((pointer as u64) << 32) | (length as u64)
}

// ─── output shapes ───

#[derive(serde::Serialize)]
struct Route {
    method: String,
    path: String,
}

#[derive(serde::Serialize)]
struct Field {
    name: String,
    r#type: String,
    flags: Vec<String>,
}

#[derive(serde::Serialize)]
struct Model {
    orm: String,
    name: String,
    fields: Vec<Field>,
    relations: Vec<String>,
}

// ─── helpers ───

fn expr_string(expression: &Expression) -> Option<String> {
    if let Expression::StringLiteral(StringLiteral { value, .. }) = expression {
        Some(value.to_string())
    } else {
        None
    }
}

// ─── routes ───

const ROUTE_VERBS: &[&str] = &["get", "post", "put", "patch", "delete", "options", "head"];

fn collect_routes(body: &[Statement], routes: &mut Vec<Route>) {
    for statement in body {
        match statement {
            Statement::ClassDef(class) => collect_routes(&class.body, routes),
            Statement::FunctionDef(function) => {
                for decorator in &function.decorator_list {
                    routes_from_decorator(&decorator.expression, routes);
                }
            }
            // Django URLConf: `urlpatterns = [path("p/", view), re_path(...), ...]`.
            Statement::Assign(Assignment { targets, value, .. }) => {
                let is_urlpatterns = targets.iter().any(|t| {
                    matches!(t, Expression::Name(NameExpression { id, .. }) if id.as_str() == "urlpatterns")
                });

                if is_urlpatterns {
                    if let Expression::List(list) = &**value {
                        for element in &list.elts {
                            routes_from_urlconf(element, routes);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

/// Extract a route from a Django URLConf entry: `path("p/", view)`, `re_path(r"^p$", view)`,
/// or legacy `url(...)`. Django doesn't bind a method at the URL layer, so we emit "ALL".
fn routes_from_urlconf(expression: &Expression, routes: &mut Vec<Route>) {
    let Expression::Call(CallExpression {
        func, arguments, ..
    }) = expression
    else {
        return;
    };

    if !matches!(call_leaf(func).as_deref(), Some("path" | "re_path" | "url")) {
        return;
    }

    if let Some(raw) = arguments.args.first().and_then(expr_string) {
        routes.push(Route {
            method: "ALL".into(),
            path: normalize_route(&raw),
        });
    }
}

/// Normalize a URLConf pattern to a leading-slash path, stripping regex anchors.
fn normalize_route(raw: &str) -> String {
    let trimmed = raw.trim_start_matches('^').trim_end_matches('$');

    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

fn routes_from_decorator(expression: &Expression, routes: &mut Vec<Route>) {
    let Expression::Call(CallExpression {
        arguments: Arguments { args, keywords, .. },
        func,
        ..
    }) = expression
    else {
        return;
    };

    let Expression::Attribute(AttributeExpression {
        attr: Identifier { id, .. },
        ..
    }) = &**func
    else {
        return;
    };

    let method = id.as_str();

    let Some(path) = args.first().and_then(expr_string) else {
        return;
    };

    if ROUTE_VERBS.contains(&method) {
        routes.push(Route {
            path,
            method: method.to_uppercase().into(),
        });

        return;
    }

    if method == "route" || method == "api_route" {
        // methods=[...] keyword, else default GET
        if let Some(keyword) = keywords
            .iter()
            .find(|keyword| keyword.arg.as_ref().map(|id| id.as_str()) == Some("methods"))
        {
            if let Expression::List(list) = &keyword.value {
                let mut any = false;

                for method in list.elts.iter().filter_map(expr_string) {
                    routes.push(Route {
                        path: path.clone(),
                        method: method.to_uppercase(),
                    });

                    any = true;
                }

                if any {
                    return;
                }
            }
        }

        routes.push(Route {
            path,
            method: "GET".into(),
        });
    }
}

// ─── imports ───

fn extract_imports(body: &[Statement]) -> Vec<String> {
    let mut imports = Vec::new();

    for statement in body {
        match statement {
            Statement::Import(import) => {
                for alias in &import.names {
                    imports.push(alias.name.to_string());
                }
            }

            Statement::ImportFrom(import) => {
                let module = import
                    .module
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_default();

                for alias in &import.names {
                    if module.is_empty() {
                        imports.push(alias.name.to_string());
                    } else {
                        imports.push(format!("{}.{}", module, alias.name));
                    }
                }
            }
            _ => {}
        }
    }

    imports
}

// ─── schemas ───

fn extract_schemas(body: &[Statement]) -> Vec<Model> {
    let mut schemas = Vec::new();

    for statement in body {
        let Statement::ClassDef(ClassDef {
            name,
            body,
            arguments,
            ..
        }) = statement
        else {
            continue;
        };

        // Heuristic: a model has at least one base class (Base/BaseModel/models.Model/...).
        let bases: Vec<String> = arguments
            .as_deref()
            .map(|args| args.args.iter().filter_map(dotted).collect())
            .unwrap_or_default();

        if bases.is_empty() {
            continue;
        }

        let mut fields = Vec::new();
        let mut relations = Vec::new();
        let mut orm: Option<&'static str> = None;

        for member in body {
            match member {
                // Annotated: `id: Mapped[int] = mapped_column(primary_key=True)`,
                // `name: str` (pydantic), `email: str = Field(unique=True)` (SQLModel).
                Statement::AnnAssign(AnnotationAssignment {
                    target,
                    annotation,
                    value,
                    ..
                }) => {
                    let Expression::Name(NameExpression { id, .. }) = &**target else {
                        continue;
                    };

                    let field_name = id.to_string();

                    if field_name.starts_with("__") {
                        continue;
                    }

                    let (mut r#type, nullable) = annotation_type(annotation);
                    let mut flags = Vec::new();

                    if let Some(call) = value.as_deref().and_then(analyze_call) {
                        orm = orm.or(call.orm);

                        if let Some(target) = call.relation {
                            relations.push(target);
                            continue;
                        }

                        flags.extend(call.flags);

                        if let Some(ctor_type) = call.ctor_type {
                            if r#type.is_empty() || r#type == "unknown" {
                                r#type = ctor_type;
                            }
                        }
                    }

                    if nullable && !flags.iter().any(|flag| flag == "nullable") {
                        flags.push("nullable".to_string());
                    }

                    fields.push(Field {
                        name: field_name,
                        r#type,
                        flags,
                    });
                }

                // Classic / Django: `name = Column(String)`, `email = models.EmailField()`,
                // `author = relationship("User")`, `team = models.ForeignKey(Team)`.
                Statement::Assign(Assignment { targets, value, .. }) => {
                    let [Expression::Name(NameExpression { id, .. })] = &targets[..] else {
                        continue;
                    };

                    let field_name = id.to_string();

                    if field_name.starts_with("__") {
                        continue;
                    }

                    let Some(call) = analyze_call(value) else {
                        continue;
                    };

                    orm = orm.or(call.orm);

                    if let Some(target) = call.relation {
                        relations.push(target);
                        continue;
                    }

                    fields.push(Field {
                        name: field_name,
                        r#type: call.ctor_type.unwrap_or_else(|| "unknown".to_string()),
                        flags: call.flags,
                    });
                }

                _ => {}
            }
        }

        if fields.is_empty() && relations.is_empty() {
            continue;
        }

        schemas.push(Model {
            orm: orm.unwrap_or_else(|| orm_from_bases(&bases)).to_string(),
            name: name.to_string(),
            fields,
            relations,
        });
    }

    schemas
}

/// What an ORM field constructor (`Column(...)`, `models.CharField(...)`, ...) tells us.
#[derive(Default)]
struct CallInfo {
    orm: Option<&'static str>,
    flags: Vec<String>,
    relation: Option<String>,
    ctor_type: Option<String>,
}

/// Inspect a field's right-hand-side call for ORM hints, flags, relations, and type.
fn analyze_call(expression: &Expression) -> Option<CallInfo> {
    let Expression::Call(CallExpression {
        func, arguments, ..
    }) = expression
    else {
        return None;
    };

    let leaf = call_leaf(func)?;
    let module = call_module(func);
    let mut info = CallInfo::default();

    if module.as_deref() == Some("models") {
        info.orm = Some("django");
    } else if matches!(leaf.as_str(), "Column" | "mapped_column" | "relationship") {
        info.orm = Some("sqlalchemy");
    }

    // Relationship / foreign-key constructors yield a relation, not a scalar column.
    const RELATIONS: &[&str] = &[
        "relationship",
        "ForeignKey",
        "ManyToManyField",
        "OneToOneField",
    ];

    if RELATIONS.contains(&leaf.as_str()) {
        info.relation = arguments.args.first().and_then(relation_target);

        if leaf != "relationship" {
            info.orm = Some("django");
        }

        return Some(info);
    }

    // Flags from truthy boolean keywords (primary_key/unique/nullable/null).
    for keyword in &arguments.keywords {
        let Some(arg) = keyword.arg.as_ref().map(Identifier::as_str) else {
            continue;
        };

        if !matches!(&keyword.value, Expression::BooleanLiteral(literal) if literal.value) {
            continue;
        }

        match arg {
            "primary_key" => info.flags.push("pk".to_string()),
            "unique" => info.flags.push("unique".to_string()),
            "nullable" | "null" => info.flags.push("nullable".to_string()),
            _ => {}
        }
    }

    // Column type: Django field leaf, or SQLAlchemy `Column(Type, ...)` first positional.
    if module.as_deref() == Some("models") {
        info.ctor_type = Some(django_type(&leaf));
    } else if leaf == "Column" || leaf == "mapped_column" {
        info.ctor_type = arguments.args.first().and_then(sqlalchemy_type);
    }

    Some(info)
}

/// Last dotted segment of a call target: `Column` -> "Column", `models.CharField` -> "CharField".
fn call_leaf(func: &Expression) -> Option<String> {
    match func {
        Expression::Name(NameExpression { id, .. }) => Some(id.to_string()),
        Expression::Attribute(AttributeExpression { attr, .. }) => Some(attr.as_str().to_string()),
        _ => None,
    }
}

/// Leading dotted segment: `models.CharField` -> "models", bare `Column` -> None.
fn call_module(func: &Expression) -> Option<String> {
    if let Expression::Attribute(AttributeExpression { value, .. }) = func {
        if let Expression::Name(NameExpression { id, .. }) = &**value {
            return Some(id.to_string());
        }
    }

    None
}

/// Render a dotted name expression: `models.Model` -> "models.Model", `Base` -> "Base".
fn dotted(expression: &Expression) -> Option<String> {
    match expression {
        Expression::Name(NameExpression { id, .. }) => Some(id.to_string()),
        Expression::Attribute(AttributeExpression { value, attr, .. }) => {
            Some(format!("{}.{}", dotted(value)?, attr.as_str()))
        }
        _ => None,
    }
}

/// Resolve a relationship/foreign-key target to a model name (`"User"`, `User`, `app.User`).
fn relation_target(expression: &Expression) -> Option<String> {
    match expression {
        Expression::StringLiteral(StringLiteral { value, .. }) => Some(value.to_string()),
        Expression::Name(_) | Expression::Attribute(_) => dotted(expression),
        _ => None,
    }
}

/// Map a base class to its ORM when the field constructors didn't already reveal it.
fn orm_from_bases(bases: &[String]) -> &'static str {
    for base in bases {
        let leaf = base.rsplit('.').next().unwrap_or(base);

        match leaf {
            "Model" if base.starts_with("models.") => return "django",
            "SQLModel" => return "sqlmodel",
            "BaseModel" => return "pydantic",
            "DeclarativeBase" | "Base" => return "sqlalchemy",
            "Model" => return "sqlalchemy", // db.Model (Flask-SQLAlchemy)
            _ => {}
        }
    }

    "unknown"
}

/// Normalize a Django field constructor to a simple type name.
fn django_type(field: &str) -> String {
    let normalized = match field {
        "CharField" | "TextField" | "SlugField" | "EmailField" | "URLField" | "FileField"
        | "ImageField" | "UUIDField" => "str",
        "IntegerField" | "BigIntegerField" | "SmallIntegerField" | "PositiveIntegerField"
        | "AutoField" | "BigAutoField" => "int",
        "FloatField" => "float",
        "DecimalField" => "decimal",
        "BooleanField" | "NullBooleanField" => "bool",
        "DateTimeField" => "datetime",
        "DateField" => "date",
        "TimeField" => "time",
        "JSONField" => "json",
        other => other,
    };

    normalized.to_string()
}

/// Normalize a SQLAlchemy `Column` type argument (`Integer`, `String(50)`, `db.Boolean`).
fn sqlalchemy_type(expression: &Expression) -> Option<String> {
    let name = match expression {
        Expression::Name(NameExpression { id, .. }) => id.to_string(),
        Expression::Attribute(AttributeExpression { attr, .. }) => attr.as_str().to_string(),
        Expression::Call(CallExpression { func, .. }) => call_leaf(func)?,
        _ => return None,
    };

    let normalized = match name.as_str() {
        "Integer" | "BigInteger" | "SmallInteger" => "int",
        "String" | "Text" | "Unicode" | "VARCHAR" | "CHAR" => "str",
        "Boolean" => "bool",
        "Float" | "Numeric" => "float",
        "DateTime" => "datetime",
        "Date" => "date",
        "Time" => "time",
        "JSON" => "json",
        _ => return Some(name),
    };

    Some(normalized.to_string())
}

/// Render an annotation to (type, nullable). `Optional[T]` / `Mapped[T]` unwrap.
fn annotation_type(expression: &Expression) -> (String, bool) {
    match expression {
        Expression::Name(NameExpression { id, .. }) => (id.to_string(), false),
        Expression::Subscript(value) => {
            let Expression::Name(NameExpression { id, .. }) = &*value.value else {
                return (String::new(), false);
            };

            match id.as_str() {
                "Mapped" => annotation_type(&value.slice),
                "Optional" => {
                    let (inner, _) = annotation_type(&value.slice);
                    (inner, true)
                }
                value => (value.to_string(), false),
            }
        }
        _ => (String::from("unknown"), false),
    }
}


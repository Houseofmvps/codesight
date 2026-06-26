//! `codesight` plugin for Rust AST parsing using [`syn`](syn).
//!
//! Implements the codesight WASM plugin ABI (see docs/wasm-plugins.md):
//!   alloc(len) -> ptr | dealloc(ptr, len)
//!   contractVersion() -> i32
//!   parseRoutes(srcPtr, srcLen) -> i64 (actix attrs + axum `.route("/p", get(...))`)
//!   parseSchemas(srcPtr, srcLen) -> i64 (named-field structs; Option<T> -> nullable, `id` -> pk)
//!   parseImports(srcPtr, srcLen) -> i64 (`use` paths, flattened to leaf paths)
//!
//! No imports (compiles for wasm32-unknown-unknown, panic = "abort").

#![allow(non_snake_case)] // exports are camelCase to match the ABI (parseRoutes, contractVersion)

use core::alloc::Layout as MemoryLayout;

use syn::{
    Attribute, Expr, ExprCall as CallExpression, ExprLit, ExprMethodCall as MethodCall,
    ExprPath as PathExpression, Field as StructField, Fields, File, GenericArgument, Item, ItemFn,
    ItemStruct, ItemUse, Lit, Path, PathArguments, Type, TypePath, TypeReference, UseGroup, UseName,
    UsePath, UseRename, UseTree, punctuated::Punctuated, visit::{self, Visit},
};

/// ABI contract version this plugin implements (must match the host's).
#[unsafe(no_mangle)]
pub extern "C" fn contractVersion() -> i32 {
    1
}

/// Self-description consumed by the host (languageId + extensions; frameworks carried).
#[unsafe(no_mangle)]
pub extern "C" fn describe() -> u64 {
    let meta = serde_json::json!({
        "languageId": "rust",
        "extensions": [
            ".rs",
        ],
        "frameworks": [
            "axum",
            "sqlx",
            "actix",
            "rocket",
            "diesel",
            "sea-orm",
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

// ─── ABI: per-kind extraction functions ───

/// # Safety
/// `source`/`length` describe a host-owned UTF-8 buffer (the host frees it).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parseRoutes(source: *const u8, length: usize) -> u64 {
    unsafe {
        parse_and_then(source, length, extract_routes)
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

/// Decode UTF-8 source, parse with [`parse_file`](syn::parse_file), run `extract`,
/// serialize, and `report`. Returns 0 on invalid UTF-8, a syntax error, or an
/// empty result (host falls back).
unsafe fn parse_and_then<T: serde::Serialize>(
    source: *const u8,
    length: usize,
    extract: impl Fn(&File) -> Vec<T>,
) -> u64 {
    let bytes = unsafe {
        core::slice::from_raw_parts(source, length)
    };

    let Ok(source) = core::str::from_utf8(bytes) else {
        return 0;
    };

    let Ok(parsed) = syn::parse_file(source) else {
        return 0;
    };

    let Ok(extracted) = serde_json::to_string(&extract(&parsed)) else {
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

// ─── Output shapes (match docs/wasm-plugins.md) ───

#[derive(serde::Serialize)]
struct Route {
    path: String,
    method: String,
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

// ─── Route Extraction ───

fn verb_for(attribute: impl ToString) -> Option<String> {
    let attribute = attribute.to_string().to_uppercase().replace("ROUTE", "ALL");

    match attribute.as_str() {
        "ALL" | "GET" | "PUT" | "HEAD" | "POST" | "PATCH" | "TRACE" | "DELETE" | "OPTIONS"
        | "CONNECT" => Some(attribute),
        _ => None,
    }
}

fn extract_routes(file: &File) -> Vec<Route> {
    let mut routes = file
        .items
        .iter()
        .filter_map(|item| {
            if let Item::Fn(ItemFn {
                attrs: attributes, ..
            }) = item
            {
                Some(attributes)
            } else {
                None
            }
        })
        .flatten()
        .filter_map(|attribute| {
            // actix-web / Rocket: verb attribute macros on functions, e.g.
            // #[get("/path")], #[post("/path", data = "<form>")].
            let method = attribute
                .path()
                .segments
                .last()
                .and_then(|segment| verb_for(&segment.ident))?;

            let path = first_str_arg(attribute)?;

            Some(Route { path, method })
        })
        .collect::<Vec<_>>();

    // axum: `.route("/path", get(handler).post(handler))`
    AxumVisitor(&mut routes).visit_file(file);

    routes
}

/// First string-literal argument of an attribute — the route path in
/// `#[get("/p")]`, `#[post("/p", data = "<x>")]`, or `#[route("/p", method = "GET")]`.
fn first_str_arg(attribute: &Attribute) -> Option<String> {
    attribute
        .parse_args_with(Punctuated::<Expr, syn::Token![,]>::parse_terminated)
        .ok()?
        .into_iter()
        .find_map(|expr| match expr {
            Expr::Lit(ExprLit {
                lit: Lit::Str(literal),
                ..
            }) => Some(literal.value()),
            _ => None,
        })
}

struct AxumVisitor<'ast>(&'ast mut Vec<Route>);

impl<'ast> Visit<'ast> for AxumVisitor<'ast> {
    fn visit_expr_method_call(&mut self, node: &'ast MethodCall) {
        if node.method == "route" {
            let mut args = node.args.iter();

            if let Some(Expr::Lit(ExprLit {
                lit: Lit::Str(argument),
                ..
            })) = args.next()
            {
                if let Some(handler) = args.next() {
                    let mut verbs = Vec::new();

                    collect_verbs(handler, &mut verbs);

                    if verbs.is_empty() {
                        verbs.push("ALL".into());
                    }

                    self.0.extend(verbs.into_iter().map(|method| Route {
                        method,
                        path: argument.value(),
                    }));
                }
            }
        }

        visit::visit_expr_method_call(self, node);
    }
}

/// Collect HTTP verbs from an `axum` routing expression like `get(h).post(h2)`.
fn collect_verbs(expr: &Expr, verbs: &mut Vec<String>) {
    match expr {
        Expr::MethodCall(MethodCall {
            method, receiver, ..
        }) => {
            if let Some(method) = verb_for(method) {
                verbs.push(method);
            }

            collect_verbs(receiver, verbs);
        }
        Expr::Call(CallExpression { func: function, .. }) => {
            if let Expr::Path(PathExpression {
                path: Path { segments, .. },
                ..
            }) = &**function
            {
                if let Some(method) = segments.last().and_then(|segment| verb_for(&segment.ident)) {
                    verbs.push(method);
                }
            }
        }
        _ => {}
    }
}

// ─── Schema Extraction ───
fn extract_schemas(file: &File) -> Vec<Model> {
    file.items
        .iter()
        .filter_map(|item| {
            let Item::Struct(ItemStruct {
                ident,
                fields: Fields::Named(fields),
                attrs,
                ..
            }) = item
            else {
                return None;
            };

            let fields = fields
                .named
                .iter()
                .filter_map(
                    |StructField {
                         ident,
                         ty: r#type,
                         attrs,
                         ..
                     }| {
                        let (name, (r#type, nullable)) = (
                            ident.as_ref().map(ToString::to_string)?,
                            type_to_string(r#type),
                        );

                        let mut flags = field_flags(attrs);

                        if nullable && !flags.iter().any(|flag| flag == "nullable") {
                            flags.push("nullable".to_string());
                        }

                        if name == "id" && !flags.iter().any(|flag| flag == "pk") {
                            flags.push("pk".to_string());
                        }

                        Some(Field {
                            name,
                            flags,
                            r#type,
                        })
                    },
                )
                .collect::<Vec<_>>();

            // Skip structs whose fields all resolved to None.
            if fields.is_empty() {
                return None;
            }

            Some(Model {
                orm: struct_orm(attrs).to_string(),
                name: ident.to_string(),
                fields,
                relations: Vec::new(),
            })
        })
        .collect()
}

/// Identify the ORM from a struct's derives/attributes (else "unknown").
fn struct_orm(attrs: &[Attribute]) -> &'static str {
    let derives = derives(attrs);
    let derived = |name: &str| derives.iter().any(|derive| derive == name);

    if derived("DeriveEntityModel") || attrs.iter().any(|attr| attr.path().is_ident("sea_orm")) {
        "sea-orm"
    } else if derived("Queryable") || derived("Insertable") || derived("Selectable")
        || derived("Identifiable")
    {
        "diesel"
    } else if derived("FromRow") {
        "sqlx"
    } else {
        "unknown"
    }
}

/// Collect the identifiers listed in every `#[derive(...)]` on an item.
fn derives(attrs: &[Attribute]) -> Vec<String> {
    let mut out = Vec::new();

    for attr in attrs.iter().filter(|attr| attr.path().is_ident("derive")) {
        let _ = attr.parse_nested_meta(|meta| {
            if let Some(ident) = meta.path.get_ident() {
                out.push(ident.to_string());
            }

            Ok(())
        });
    }

    out
}

/// Field-level flags from `#[sea_orm(primary_key)]` / `#[sea_orm(unique)]`.
fn field_flags(attrs: &[Attribute]) -> Vec<String> {
    let mut flags = Vec::new();

    for attr in attrs.iter().filter(|attr| attr.path().is_ident("sea_orm")) {
        let _ = attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("primary_key") {
                flags.push("pk".to_string());
            }

            if meta.path.is_ident("unique") {
                flags.push("unique".to_string());
            }

            Ok(())
        });
    }

    flags
}

/// Returns (rendered type, nullable). `Option<T>` unwraps to T + nullable.
fn type_to_string(r#type: &Type) -> (String, bool) {
    match r#type {
        Type::Reference(TypeReference { elem: r#type, .. }) => {
            return type_to_string(r#type);
        }
        Type::Path(TypePath {
            path: Path { segments, .. },
            ..
        }) => {
            if let Some(segment) = segments.last() {
                let id = segment.ident.to_string();

                if id == "Option" {
                    if let PathArguments::AngleBracketed(brackets) = &segment.arguments {
                        if let Some(GenericArgument::Type(inner)) = brackets.args.first() {
                            let (string, _) = type_to_string(inner);
                            return (string, true);
                        }
                    }
                }

                return (id, false);
            }
        }
        _ => {}
    };

    ("unknown".into(), false)
}

// ─── Import Extraction ───

fn extract_imports(File { items, .. }: &File) -> Vec<String> {
    items
        .iter()
        .filter_map(|item| {
            if let Item::Use(ItemUse { tree, .. }) = item {
                Some(tree)
            } else {
                None
            }
        })
        .fold(Vec::new(), |mut imports, tree| {
            flatten_use(tree, "", &mut imports);
            imports
        })
}

fn flatten_use(tree: &UseTree, prefix: impl Clone + core::fmt::Display, out: &mut Vec<String>) {
    match tree {
        UseTree::Glob(_) => out.push(join(prefix, "*")),
        UseTree::Path(UsePath { tree, ident, .. }) => {
            flatten_use(tree, join(prefix, ident.to_string()), out)
        }
        UseTree::Name(UseName { ident, .. }) | UseTree::Rename(UseRename { ident, .. }) => {
            out.push(join(prefix, ident))
        }
        UseTree::Group(UseGroup { items, .. }) => {
            for item in items {
                flatten_use(item, prefix.clone(), out);
            }
        }
    }
}

fn join(prefix: impl core::fmt::Display, suffix: impl core::fmt::Display) -> String {
    let prefix = prefix.to_string();

    if prefix.is_empty() {
        suffix.to_string()
    } else {
        format!("{prefix}::{suffix}")
    }
}

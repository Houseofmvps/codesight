// codesight native-AST plugin for Go, parsing with the stdlib go/parser.
//
// Implements the codesight WASM plugin ABI (see docs/wasm-plugins.md) as a
// WASI *reactor*: built with `GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared`,
// exporting functions via //go:wasmexport. Unlike the Rust/AssemblyScript
// plugins it is NOT a no-imports module — the Go runtime imports
// wasi_snapshot_preview1 for init (clock/random/exit/stderr), which the host
// supplies via a minimal, no-filesystem WASI environment.
//
// Exports: contractVersion, describe, alloc, dealloc, parseRoutes, parseSchemas, parseImports.
//   routes  : Gin/Echo (`.GET("/p")`), Fiber/Chi (`.Get("/p")`) method calls,
//             router groups (`r.Group("/api")` prefixes), and net/http mux
//             (`HandleFunc`/`Handle`, incl. Go 1.22 `"GET /p"` method patterns)
//   schemas : GORM structs (gorm.Model embed or `gorm:` tags) and Ent schemas
//             (`func (T) Fields() []ent.Field`)
//   imports : import paths
package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"strings"
	"unsafe"
)

func main() {}

// ─── ABI: version + self-description ───

//go:wasmexport contractVersion
func contractVersion() int32 { return 1 }

//go:wasmexport describe
func describe() uint64 {
	return report([]byte(`{"languageId":"go","extensions":[".go"],"frameworks":["gin","echo","fiber","chi","net/http","gorm","ent"]}`))
}

// ─── ABI: memory ───
//
// The host writes source into a buffer we hand it via alloc, and reads our JSON
// output from a buffer we return. Go's wasm GC is non-moving, so a pointer into
// a live []byte stays valid; we keep buffers alive in `keep` until dealloc.

var keep = map[uint32][]byte{}

//go:wasmexport alloc
func alloc(n uint32) uint32 {
	if n == 0 {
		return 0
	}
	b := make([]byte, n)
	ptr := uint32(uintptr(unsafe.Pointer(&b[0])))
	keep[ptr] = b
	return ptr
}

//go:wasmexport dealloc
func dealloc(ptr uint32, _ uint32) {
	delete(keep, ptr)
}

// ─── ABI: per-kind parse entry points ───

//go:wasmexport parseRoutes
func parseRoutes(srcPtr, srcLen uint32) uint64 {
	return parseAndThen(srcPtr, srcLen, func(f *ast.File) any { return extractRoutes(f) })
}

//go:wasmexport parseSchemas
func parseSchemas(srcPtr, srcLen uint32) uint64 {
	return parseAndThen(srcPtr, srcLen, func(f *ast.File) any { return extractSchemas(f) })
}

//go:wasmexport parseImports
func parseImports(srcPtr, srcLen uint32) uint64 {
	return parseAndThen(srcPtr, srcLen, func(f *ast.File) any { return extractImports(f) })
}

func parseAndThen(srcPtr, srcLen uint32, extract func(*ast.File) any) uint64 {
	src := readSource(srcPtr, srcLen)
	fileSet := token.NewFileSet()

	file, err := parser.ParseFile(fileSet, "input.go", src, 0)

	if err != nil {
		return 0 // not parseable -> "nothing", host falls back
	}

	out, err := json.Marshal(extract(file))

	if err != nil {
		return 0
	}

	s := string(out)

	if s == "[]" || s == "null" || len(s) == 0 {
		return 0
	}

	return report(out)
}

func readSource(ptr, length uint32) string {
	if length == 0 {
		return ""
	}
	return string(unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), length))
}

func report(b []byte) uint64 {
	n := uint32(len(b))
	ptr := alloc(n)
	dst := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), n)
	copy(dst, b)
	return (uint64(ptr) << 32) | uint64(n)
}

// ─── output shapes ───

type Route struct {
	Path   string `json:"path"`
	Method string `json:"method"`
}

type Field struct {
	Name  string   `json:"name"`
	Type  string   `json:"type"`
	Flags []string `json:"flags"`
}

type Model struct {
	Orm       string   `json:"orm"`
	Name      string   `json:"name"`
	Fields    []Field  `json:"fields"`
	Relations []string `json:"relations"`
}

// ─── routes ───

var verbs = map[string]string{
	"GET": "GET", "POST": "POST", "PUT": "PUT", "PATCH": "PATCH",
	"DELETE": "DELETE", "OPTIONS": "OPTIONS", "HEAD": "HEAD",
	"Get": "GET", "Post": "POST", "Put": "PUT", "Patch": "PATCH",
	"Delete": "DELETE", "Options": "OPTIONS", "Head": "HEAD",
}

func extractRoutes(f *ast.File) []Route {
	out := []Route{}
	prefixes := groupPrefixes(f)
	ast.Inspect(f, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || len(call.Args) == 0 {
			return true
		}

		// net/http: HandleFunc / Handle, with optional Go 1.22 "VERB /path" pattern.
		if sel.Sel.Name == "HandleFunc" || sel.Sel.Name == "Handle" {
			if pat, ok := stringLit(call.Args[0]); ok {
				if method, path, ok := splitPattern(pat); ok {
					out = append(out, Route{Method: method, Path: path})
				}
			}
			return true
		}

		// Framework method calls: r.GET("/p"), g.Get("/p"), etc.
		method, ok := verbs[sel.Sel.Name]
		if !ok {
			return true
		}
		if path, ok := stringLit(call.Args[0]); ok && strings.HasPrefix(path, "/") {
			out = append(out, Route{Method: method, Path: joinPath(prefixOf(sel.X, prefixes), path)})
		}
		return true
	})
	return out
}

// groupPrefixes resolves router-group variables to their accumulated path prefix,
// e.g. `api := r.Group("/api"); v1 := api.Group("/v1")` => {api:/api, v1:/api/v1}.
func groupPrefixes(f *ast.File) map[string]string {
	type assign struct {
		lhs  string
		recv ast.Expr
		lit  string
	}
	var items []assign
	ast.Inspect(f, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if !ok || len(as.Lhs) != 1 || len(as.Rhs) != 1 {
			return true
		}
		lhs, ok := as.Lhs[0].(*ast.Ident)
		if !ok {
			return true
		}
		lit, recv, ok := groupCall(as.Rhs[0])
		if !ok {
			return true
		}
		items = append(items, assign{lhs.Name, recv, lit})
		return true
	})

	prefixes := map[string]string{}
	// Iterate to a fixpoint so out-of-order / nested groups resolve.
	for pass := 0; pass <= len(items); pass++ {
		changed := false
		for _, it := range items {
			base := ""
			if id, ok := it.recv.(*ast.Ident); ok {
				base = prefixes[id.Name]
			}
			val := joinPath(base, it.lit)
			if prefixes[it.lhs] != val {
				prefixes[it.lhs] = val
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	return prefixes
}

// groupCall returns (prefixLiteral, receiverExpr, ok) for a `recv.Group("/p")` call.
func groupCall(e ast.Expr) (string, ast.Expr, bool) {
	call, ok := e.(*ast.CallExpr)
	if !ok {
		return "", nil, false
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Group" || len(call.Args) == 0 {
		return "", nil, false
	}
	lit, ok := stringLit(call.Args[0])
	if !ok {
		return "", nil, false
	}
	return lit, sel.X, true
}

// prefixOf resolves the path prefix for a route call's receiver — a group
// variable (`api.GET(...)`) or an inline group chain (`r.Group("/api").GET(...)`).
func prefixOf(recv ast.Expr, prefixes map[string]string) string {
	switch r := recv.(type) {
	case *ast.Ident:
		return prefixes[r.Name]
	case *ast.CallExpr:
		if lit, base, ok := groupCall(r); ok {
			parent := ""
			if id, ok := base.(*ast.Ident); ok {
				parent = prefixes[id.Name]
			}
			return joinPath(parent, lit)
		}
	}
	return ""
}

func joinPath(prefix, path string) string {
	if prefix == "" {
		return path
	}
	prefix = strings.TrimRight(prefix, "/")
	if path == "" || path == "/" {
		return prefix
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return prefix + path
}

// splitPattern parses a net/http mux pattern. Go 1.22 allows a leading method
// (and optional host): "GET /items/{id}" => (GET, /items/{id}). A bare pattern
// matches any method => "ALL". Returns ok=false for non-path patterns.
func splitPattern(pat string) (string, string, bool) {
	pat = strings.TrimSpace(pat)
	method := "ALL"
	if i := strings.IndexByte(pat, ' '); i > 0 {
		if v, ok := verbs[pat[:i]]; ok {
			method = v
			pat = strings.TrimSpace(pat[i+1:])
		}
	}
	// Strip an optional host component preceding the path.
	if j := strings.IndexByte(pat, '/'); j > 0 {
		pat = pat[j:]
	}
	if !strings.HasPrefix(pat, "/") {
		return "", "", false
	}
	return method, pat, true
}

func stringLit(e ast.Expr) (string, bool) {
	if b, ok := e.(*ast.BasicLit); ok && b.Kind == token.STRING {
		if s, err := strconv.Unquote(b.Value); err == nil {
			return s, true
		}
	}
	return "", false
}

// ─── schemas (GORM + Ent) ───

func extractSchemas(f *ast.File) []Model {
	out := extractGorm(f)
	out = append(out, extractEnt(f)...)
	return out
}

func extractGorm(f *ast.File) []Model {
	out := []Model{}
	for _, decl := range f.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.TYPE {
			continue
		}
		for _, spec := range gd.Specs {
			ts, ok := spec.(*ast.TypeSpec)
			if !ok {
				continue
			}
			st, ok := ts.Type.(*ast.StructType)
			if !ok {
				continue
			}
			fields := []Field{}
			isModel := false
			for _, fld := range st.Fields.List {
				typeStr := exprString(fld.Type)
				if len(fld.Names) == 0 {
					// embedded field, e.g. gorm.Model
					if typeStr == "gorm.Model" {
						isModel = true
						fields = append(fields,
							Field{Name: "ID", Type: "uint", Flags: []string{"pk"}},
							Field{Name: "CreatedAt", Type: "time.Time", Flags: []string{}},
							Field{Name: "UpdatedAt", Type: "time.Time", Flags: []string{}},
						)
					}
					continue
				}
				flags := []string{}
				if fld.Tag != nil {
					tag := fld.Tag.Value
					if strings.Contains(tag, "gorm:") {
						isModel = true
					}
					if strings.Contains(tag, "primaryKey") || strings.Contains(tag, "primarykey") {
						flags = append(flags, "pk")
					}
					if strings.Contains(tag, "unique") {
						flags = append(flags, "unique")
					}
					if strings.Contains(tag, "not null") {
						flags = append(flags, "required")
					}
				}
				for _, name := range fld.Names {
					if !name.IsExported() {
						continue
					}
					fields = append(fields, Field{Name: name.Name, Type: typeStr, Flags: flags})
				}
			}
			if isModel && len(fields) > 0 {
				out = append(out, Model{Name: ts.Name.Name, Fields: fields, Relations: []string{}, Orm: "gorm"})
			}
		}
	}
	return out
}

// extractEnt parses Ent schemas: `func (T) Fields() []ent.Field { return
// []ent.Field{ field.String("sku").Optional(), field.Int("price") } }`.
func extractEnt(f *ast.File) []Model {
	out := []Model{}
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "Fields" || fn.Recv == nil || len(fn.Recv.List) == 0 || fn.Body == nil {
			continue
		}
		name := recvTypeName(fn.Recv.List[0].Type)
		if name == "" {
			continue
		}
		fields := []Field{}
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			cl, ok := n.(*ast.CompositeLit)
			if !ok {
				return true
			}
			for _, elt := range cl.Elts {
				if fld, ok := entField(elt); ok {
					fields = append(fields, fld)
				}
			}
			return true
		})
		if len(fields) > 0 {
			out = append(out, Model{Name: name, Fields: fields, Relations: []string{}, Orm: "ent"})
		}
	}
	return out
}

// entField walks an Ent builder chain `field.String("name").Optional().Unique()`,
// collecting modifiers on the way down to the base `field.TYPE("name")` call.
func entField(e ast.Expr) (Field, bool) {
	flags := []string{}
	cur := e
	for {
		call, ok := cur.(*ast.CallExpr)
		if !ok {
			return Field{}, false
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return Field{}, false
		}
		if base, ok := sel.X.(*ast.Ident); ok && base.Name == "field" {
			if len(call.Args) == 0 {
				return Field{}, false
			}
			name, ok := stringLit(call.Args[0])
			if !ok {
				return Field{}, false
			}
			return Field{Name: name, Type: entType(sel.Sel.Name), Flags: flags}, true
		}
		switch sel.Sel.Name {
		case "Optional", "Nillable":
			flags = append(flags, "nullable")
		case "Unique":
			flags = append(flags, "unique")
		}
		cur = sel.X
	}
}

func entType(ctor string) string {
	switch ctor {
	case "String", "Text", "UUID", "Enum":
		return "string"
	case "Int", "Int8", "Int16", "Int32", "Int64":
		return "int"
	case "Uint", "Uint8", "Uint16", "Uint32", "Uint64":
		return "uint"
	case "Float", "Float32":
		return "float64"
	case "Bool":
		return "bool"
	case "Time":
		return "time.Time"
	case "Bytes":
		return "[]byte"
	case "JSON":
		return "json"
	}
	return strings.ToLower(ctor)
}

func recvTypeName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return recvTypeName(t.X)
	}
	return ""
}

func exprString(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.SelectorExpr:
		return exprString(t.X) + "." + t.Sel.Name
	case *ast.StarExpr:
		return exprString(t.X)
	case *ast.ArrayType:
		return "[]" + exprString(t.Elt)
	default:
		return "unknown"
	}
}

// ─── imports ───

func extractImports(f *ast.File) []string {
	out := []string{}
	for _, imp := range f.Imports {
		if p, err := strconv.Unquote(imp.Path.Value); err == nil {
			out = append(out, p)
		}
	}
	return out
}

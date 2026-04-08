/**
 * AST-based route extraction for TypeScript/JavaScript frameworks.
 * Provides higher accuracy than regex for:
 * - Express/Hono/Fastify/Koa/Elysia: method calls with path strings
 * - NestJS: decorator-based routes with controller prefix combining
 * - tRPC: router object with procedure chains and nesting
 */
import type { RouteInfo, Framework } from "../types.js";
import { parseSourceFile, getDecorators, parseDecorator, getText } from "./loader.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);

function extractPathParams(path: string): string[] {
  const params: string[] = [];
  const regex = /[:{}](\w+)/g;
  let m;
  while ((m = regex.exec(path)) !== null) params.push(m[1]);
  return params;
}

/**
 * Try AST-based route extraction for a single file.
 * Returns routes with confidence: 'ast', or empty array if AST cannot handle this file.
 */
export function extractRoutesAST(
  ts: any,
  filePath: string,
  content: string,
  framework: Framework,
  tags: string[]
): RouteInfo[] {
  try {
    const sf = parseSourceFile(ts, filePath, content);
    switch (framework) {
      case "express":
      case "hono":
      case "fastify":
      case "koa":
      case "elysia":
        return extractHttpFrameworkRoutes(ts, sf, filePath, content, framework, tags);
      case "nestjs":
        return extractNestJSRoutes(ts, sf, filePath, content, tags);
      case "trpc":
        return extractTRPCRoutes(ts, sf, filePath, content, tags);
      default:
        return [];
    }
  } catch {
    return []; // AST parsing failed — caller falls back to regex
  }
}

// ─── Express / Hono / Fastify / Koa / Elysia ───

function extractHttpFrameworkRoutes(
  ts: any,
  sf: any,
  filePath: string,
  _content: string,
  framework: Framework,
  tags: string[]
): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const SK = ts.SyntaxKind;

  // Track router.use('/prefix', subRouter) for prefix resolution
  const prefixMap = new Map<string, string>(); // variable name -> prefix

  // Track createRoute() definitions: variable name -> { method, path }
  const routeDefMap = new Map<string, { method: string; path: string }>();

  function visit(node: any) {
    // Track createRoute({ method, path }) variable assignments
    if (node.kind === SK.VariableStatement) {
      for (const decl of node.declarationList?.declarations || []) {
        if (decl.initializer?.kind === SK.CallExpression) {
          const callee = decl.initializer.expression;
          if (callee?.kind === SK.Identifier && getText(sf, callee) === "createRoute") {
            const routeDef = extractCreateRouteArgs(ts, sf, decl.initializer);
            if (routeDef && decl.name?.kind === SK.Identifier) {
              routeDefMap.set(getText(sf, decl.name), routeDef);
            }
          }
        }
      }
    }

    if (node.kind === SK.CallExpression) {
      const expr = node.expression;

      if (expr?.kind === SK.PropertyAccessExpression) {
        const methodName = getText(sf, expr.name).toLowerCase();
        const receiverName = expr.expression?.kind === SK.Identifier
          ? getText(sf, expr.expression)
          : "";

        // Track .use('/prefix', variable) for prefix chains
        if (methodName === "use" && node.arguments?.length >= 2) {
          const first = node.arguments[0];
          const second = node.arguments[1];
          if (
            (first.kind === SK.StringLiteral || first.kind === SK.NoSubstitutionTemplateLiteral) &&
            second.kind === SK.Identifier
          ) {
            const prefix = first.text;
            const routerVar = getText(sf, second);
            prefixMap.set(routerVar, prefix);
          }
        }

        // .openapi(routeDef, handler) — resolve createRoute() definitions
        if (methodName === "openapi" && node.arguments?.length > 0) {
          const routeArg = node.arguments[0];

          // Inline createRoute({ method, path }) call
          if (routeArg.kind === SK.CallExpression) {
            const callee = routeArg.expression;
            if (callee?.kind === SK.Identifier && getText(sf, callee) === "createRoute") {
              const routeDef = extractCreateRouteArgs(ts, sf, routeArg);
              if (routeDef) {
                routes.push({
                  method: routeDef.method.toUpperCase(),
                  path: routeDef.path,
                  file: filePath,
                  tags,
                  framework,
                  params: extractPathParams(routeDef.path),
                  confidence: "ast",
                });
              }
            }
          }

          // Variable reference: .openapi(getActiveRoute, handler)
          if (routeArg.kind === SK.Identifier) {
            const varName = getText(sf, routeArg);
            const routeDef = routeDefMap.get(varName);
            if (routeDef) {
              routes.push({
                method: routeDef.method.toUpperCase(),
                path: routeDef.path,
                file: filePath,
                tags,
                framework,
                params: extractPathParams(routeDef.path),
                confidence: "ast",
              });
            }
          }
        }

        // Route registration: .get('/path', ...) .post('/path', ...) etc.
        if (HTTP_METHODS.has(methodName) && node.arguments?.length > 0) {
          const pathArg = node.arguments[0];
          let path: string | null = null;

          if (pathArg.kind === SK.StringLiteral || pathArg.kind === SK.NoSubstitutionTemplateLiteral) {
            path = pathArg.text;
          }

          if (path !== null) {
            // Filter: route paths must start with / or : — skip context.get("key") calls
            if (!path.startsWith("/") && !path.startsWith(":")) {
              ts.forEachChild(node, visit);
              return;
            }

            // Apply prefix if this receiver has one registered
            const prefix = prefixMap.get(receiverName) || "";
            const fullPath = prefix ? (prefix + path).replace(/\/\//g, "/") : path;

            // Extract middleware names from intermediate arguments
            const middleware: string[] = [];
            for (let i = 1; i < node.arguments.length; i++) {
              const arg = node.arguments[i];
              if (arg.kind === SK.Identifier) {
                middleware.push(getText(sf, arg));
              }
            }

            routes.push({
              method: methodName.toUpperCase() === "ALL" ? "ALL" : methodName.toUpperCase(),
              path: fullPath,
              file: filePath,
              tags,
              framework,
              params: extractPathParams(fullPath),
              confidence: "ast",
              middleware,
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return routes;
}

/** Extract method and path from createRoute({ method: '...', path: '...' }) */
function extractCreateRouteArgs(
  ts: any,
  sf: any,
  callExpr: any
): { method: string; path: string } | null {
  const SK = ts.SyntaxKind;
  if (!callExpr.arguments?.length) return null;
  const arg = callExpr.arguments[0];
  if (arg.kind !== SK.ObjectLiteralExpression) return null;

  let method: string | null = null;
  let path: string | null = null;

  for (const prop of arg.properties || []) {
    if (prop.kind !== SK.PropertyAssignment || !prop.name) continue;
    const name = getText(sf, prop.name);
    const val = prop.initializer;
    if (name === "method" && (val.kind === SK.StringLiteral || val.kind === SK.NoSubstitutionTemplateLiteral)) {
      method = val.text;
    }
    if (name === "path" && (val.kind === SK.StringLiteral || val.kind === SK.NoSubstitutionTemplateLiteral)) {
      path = val.text;
    }
  }

  return method && path ? { method, path } : null;
}

// ─── NestJS ───

const NEST_METHOD_MAP: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Options: "OPTIONS",
  Head: "HEAD",
  All: "ALL",
};

function extractNestJSRoutes(
  ts: any,
  sf: any,
  filePath: string,
  _content: string,
  tags: string[]
): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const SK = ts.SyntaxKind;

  function visitNode(node: any) {
    if (node.kind === SK.ClassDeclaration) {
      const decorators = getDecorators(ts, node);

      // Find @Controller decorator and extract prefix
      let controllerPrefix = "";
      let isController = false;
      for (const dec of decorators) {
        const parsed = parseDecorator(ts, sf, dec);
        if (parsed.name === "Controller") {
          isController = true;
          controllerPrefix = parsed.arg || "";
          break;
        }
      }

      if (!isController) {
        ts.forEachChild(node, visitNode);
        return;
      }

      // Extract guards at class level
      const classGuards: string[] = [];
      for (const dec of decorators) {
        const parsed = parseDecorator(ts, sf, dec);
        if (parsed.name === "UseGuards" && parsed.arg) {
          classGuards.push(parsed.arg);
        }
      }

      // Visit methods
      for (const member of node.members || []) {
        if (member.kind !== SK.MethodDeclaration) continue;

        const methodDecorators = getDecorators(ts, member);

        for (const dec of methodDecorators) {
          const parsed = parseDecorator(ts, sf, dec);
          if (!parsed.name || !NEST_METHOD_MAP[parsed.name]) continue;

          const methodPath = parsed.arg || "";
          const combined = [controllerPrefix, methodPath].filter(Boolean).join("/");
          const fullPath = "/" + combined.replace(/^\/+/, "").replace(/\/+/g, "/");
          const normalizedPath = fullPath.replace(/\/$/, "") || "/";

          // Extract @Param, @Body, @Query from method parameters
          const params: string[] = [];
          const middleware: string[] = [...classGuards];
          for (const param of member.parameters || []) {
            const paramDecs = getDecorators(ts, param);
            for (const pd of paramDecs) {
              const pp = parseDecorator(ts, sf, pd);
              if (pp.name === "Param" && pp.arg) params.push(pp.arg);
            }
          }

          // Method-level guards
          for (const mdec of methodDecorators) {
            const mp = parseDecorator(ts, sf, mdec);
            if (mp.name === "UseGuards" && mp.arg) middleware.push(mp.arg);
          }

          routes.push({
            method: NEST_METHOD_MAP[parsed.name],
            path: normalizedPath,
            file: filePath,
            tags,
            framework: "nestjs",
            params: params.length > 0 ? params : extractPathParams(normalizedPath),
            confidence: "ast",
            middleware: middleware.length > 0 ? middleware : undefined,
          });
        }
      }
    }

    ts.forEachChild(node, visitNode);
  }

  visitNode(sf);
  return routes;
}

// ─── tRPC ───

function extractTRPCRoutes(
  ts: any,
  sf: any,
  filePath: string,
  _content: string,
  tags: string[]
): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const SK = ts.SyntaxKind;

  function isRouterCall(node: any): boolean {
    if (node.kind !== SK.CallExpression) return false;
    const callee = node.expression;
    if (callee.kind === SK.Identifier) {
      const name = getText(sf, callee);
      return name === "router" || name === "createTRPCRouter";
    }
    if (callee.kind === SK.PropertyAccessExpression) {
      return getText(sf, callee.name) === "router";
    }
    return false;
  }

  function findProcedureMethod(node: any): string | null {
    if (!node || node.kind !== SK.CallExpression) return null;
    const expr = node.expression;
    if (expr?.kind === SK.PropertyAccessExpression) {
      const name = getText(sf, expr.name);
      if (name === "query") return "QUERY";
      if (name === "mutation") return "MUTATION";
      if (name === "subscription") return "SUBSCRIPTION";
    }
    return null;
  }

  function extractFromRouter(node: any, prefix: string) {
    if (!isRouterCall(node) || !node.arguments?.length) return;

    const arg = node.arguments[0];
    if (arg.kind !== SK.ObjectLiteralExpression) return;

    for (const prop of arg.properties || []) {
      if (prop.kind === SK.PropertyAssignment) {
        const name = prop.name ? getText(sf, prop.name) : "";
        if (!name) continue;
        const init = prop.initializer;

        // Nested router
        if (isRouterCall(init)) {
          extractFromRouter(init, prefix ? `${prefix}.${name}` : name);
          continue;
        }

        // Procedure: look for .query() / .mutation() / .subscription()
        const method = findProcedureMethod(init);
        if (method) {
          routes.push({
            method,
            path: prefix ? `${prefix}.${name}` : name,
            file: filePath,
            tags,
            framework: "trpc",
            confidence: "ast",
          });
          continue;
        }

        // Could be a reference to another router variable — can't resolve without types
      }

      if (prop.kind === SK.SpreadAssignment) {
        // ...otherRoutes — can't resolve statically
      }
    }
  }

  // Find all router() calls in the file
  function visit(node: any) {
    if (isRouterCall(node)) {
      extractFromRouter(node, "");
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return routes;
}

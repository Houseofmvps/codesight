import { relative, basename } from "node:path";
import { readFileSafe } from "../scanner.js";
import { loadTypeScript } from "../ast/loader.js";
import { extractRoutesAST } from "../ast/extract-routes.js";
import { extractPythonRoutesAST } from "../ast/extract-python.js";
import { extractGoRoutesStructured } from "../ast/extract-go.js";
import { extractLaravelRoutes } from "../ast/extract-php.js";
import { extractAspNetControllerRoutes, extractAspNetMinimalApiRoutes } from "../ast/extract-csharp.js";
import { extractFlutterRoutes } from "../ast/extract-dart.js";
import { extractVaporRoutes } from "../ast/extract-swift.js";
import { extractRetrofitRoutes, extractNavigationRoutes, extractActivitiesFromManifest } from "../ast/extract-android.js";
import type { RouteInfo, Framework, ProjectInfo, CodesightConfig } from "../types.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

const TAG_PATTERNS: [string, RegExp[]][] = [
  ["auth", [/auth/i, /jwt/i, /token/i, /session/i, /bearer/i, /passport/i, /clerk/i, /betterAuth/i, /better-auth/i]],
  ["db", [/prisma/i, /drizzle/i, /typeorm/i, /sequelize/i, /mongoose/i, /knex/i, /sql/i, /\.query\(/i, /\.execute\(/i, /\.findMany\(/i, /\.findFirst\(/i, /\.insert\(/i, /\.update\(/i, /\.delete\(/i]],
  ["cache", [/redis/i, /cache/i, /memcache/i, /\.setex\(/i, /\.getex\(/i]],
  ["queue", [/bullmq/i, /bull\b/i, /\.add\(\s*['"`]/i, /queue/i]],
  ["email", [/resend/i, /sendgrid/i, /nodemailer/i, /\.send\(\s*\{[\s\S]*?to:/i]],
  ["payment", [/stripe/i, /polar/i, /paddle/i, /lemon/i, /checkout/i, /webhook/i]],
  ["upload", [/multer/i, /formidable/i, /busboy/i, /upload/i, /multipart/i]],
  ["ai", [/openai/i, /anthropic/i, /claude/i, /\.chat\.completions/i, /\.messages\.create/i]],
];

function detectTags(content: string): string[] {
  const tags: string[] = [];
  for (const [tag, patterns] of TAG_PATTERNS) {
    if (patterns.some((p) => p.test(content))) {
      tags.push(tag);
    }
  }
  return tags;
}

export async function detectRoutes(
  files: string[],
  project: ProjectInfo,
  config?: CodesightConfig
): Promise<RouteInfo[]> {
  const routes: RouteInfo[] = [];

  for (const fw of project.frameworks) {
    switch (fw) {
      case "next-app":
        routes.push(...(await detectNextAppRoutes(files, project)));
        break;
      case "next-pages":
        routes.push(...(await detectNextPagesApi(files, project)));
        break;
      case "hono":
        routes.push(...(await detectHonoRoutes(files, project)));
        break;
      case "express":
        routes.push(...(await detectExpressRoutes(files, project)));
        break;
      case "fastify":
        routes.push(...(await detectFastifyRoutes(files, project)));
        break;
      case "koa":
        routes.push(...(await detectKoaRoutes(files, project)));
        break;
      case "nestjs":
        routes.push(...(await detectNestJSRoutes(files, project)));
        break;
      case "elysia":
        routes.push(...(await detectElysiaRoutes(files, project)));
        break;
      case "adonis":
        routes.push(...(await detectAdonisRoutes(files, project)));
        break;
      case "trpc":
        routes.push(...(await detectTRPCRoutes(files, project)));
        break;
      case "sveltekit":
        routes.push(...(await detectSvelteKitRoutes(files, project)));
        break;
      case "remix":
        routes.push(...(await detectRemixRoutes(files, project)));
        break;
      case "nuxt":
        routes.push(...(await detectNuxtRoutes(files, project)));
        break;
      case "fastapi":
        routes.push(...(await detectFastAPIRoutes(files, project)));
        break;
      case "flask":
        routes.push(...(await detectFlaskRoutes(files, project)));
        break;
      case "django":
        routes.push(...(await detectDjangoRoutes(files, project)));
        break;
      case "gin":
      case "go-net-http":
      case "fiber":
      case "echo":
      case "chi":
        routes.push(...(await detectGoRoutes(files, project, fw)));
        break;
      case "rails":
        routes.push(...(await detectRailsRoutes(files, project)));
        break;
      case "phoenix":
        routes.push(...(await detectPhoenixRoutes(files, project)));
        break;
      case "spring":
        routes.push(...(await detectSpringRoutes(files, project)));
        break;
      case "ktor":
        routes.push(...(await detectKtorRoutes(files, project)));
        break;
      case "actix":
      case "axum":
        routes.push(...(await detectRustRoutes(files, project, fw)));
        break;
      case "raw-http":
        routes.push(...(await detectRawHttpRoutes(files, project)));
        break;
      case "php":
        routes.push(...(await detectPHPRoutes(files, project)));
        break;
      case "laravel":
        routes.push(...(await detectLaravelRoutes(files, project)));
        break;
      case "aspnet":
        routes.push(...(await detectAspNetRoutes(files, project)));
        break;
      case "flutter":
        routes.push(...(await detectFlutterGoRoutes(files, project)));
        break;
      case "vapor":
        routes.push(...(await detectVaporRoutes(files, project)));
        break;
      case "android":
        routes.push(...(await detectAndroidRoutes(files, project)));
        break;
      case "angular":
        routes.push(...(await detectAngularRoutes(files, project)));
        break;
    }
  }

  // Resolve mount prefixes BEFORE deduplication so routes from different
  // sub-routers sharing a path (e.g. POST /generate in cv.py AND cover_letter.py)
  // become distinct after prefix application (POST /api/cv/generate, etc.)
  const prefixed = await resolveRoutePrefixes(routes, files, project);

  // Deduplicate: same method + path from different files/frameworks
  const seen = new Set<string>();
  const deduped: RouteInfo[] = [];
  for (const route of prefixed) {
    const key = `${route.method}:${route.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(route);
    }
  }

  // Apply customRoutePatterns from config
  if (config?.customRoutePatterns?.length) {
    for (const file of files) {
      const content = await readFileSafe(file);
      if (!content) continue;
      const rel = relative(process.cwd(), file);

      for (const { pattern, method = "ALL" } of config.customRoutePatterns) {
        let re: RegExp;
        try {
          re = new RegExp(pattern, "g");
        } catch {
          continue;
        }

        for (const match of content.matchAll(re)) {
          // Try to extract a path from the first capture group, fallback to file path
          const extractedPath = match[1] ?? `/${rel}`;
          const routeKey = `${method}:${extractedPath}`;
          if (!seen.has(routeKey)) {
            seen.add(routeKey);
            deduped.push({
              method,
              path: extractedPath,
              file: rel,
              tags: detectTags(content),
              framework: project.frameworks[0] ?? "raw-http",
              confidence: "regex",
            });
          }
        }
      }
    }
  }

  return deduped;
}

// --- Next.js App Router ---
async function detectNextAppRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const routeFiles = files.filter(
    (f) => f.match(/[/\\]app[/\\].*[/\\]route\.(ts|js|tsx|jsx)$/) || f.match(/[/\\]app[/\\]route\.(ts|js|tsx|jsx)$/)
  );
  const routes: RouteInfo[] = [];

  for (const file of routeFiles) {
    const content = await readFileSafe(file);
    const rel = relative(project.root, file).replace(/\\/g, "/");
    // Match /app/ or /src/app/ as a directory boundary (not inside "apps/...")
    const pathMatch = rel.match(/(?:^|\/)(?:src\/)?app(?=\/)(\/.*?)\/route\./);
    let apiPath = pathMatch ? pathMatch[1] || "/" : "/";
    // Remove Next.js route groups like (marketing), (auth), etc.
    apiPath = apiPath.replace(/\/\([^)]+\)/g, "") || "/";

    for (const method of HTTP_METHODS) {
      const pattern = new RegExp(
        `export\\s+(?:async\\s+)?function\\s+${method}\\b`
      );
      if (pattern.test(content)) {
        routes.push({
          method,
          path: apiPath,
          file: rel,
          tags: detectTags(content),
          framework: "next-app",
        });
      }
    }
  }

  return routes;
}

// --- Next.js Pages API ---
async function detectNextPagesApi(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const apiFiles = files.filter((f) =>
    f.match(/[/\\]pages[/\\]api[/\\].*\.(ts|js|tsx|jsx)$/)
  );
  const routes: RouteInfo[] = [];

  for (const file of apiFiles) {
    const content = await readFileSafe(file);
    const rel = relative(project.root, file).replace(/\\/g, "/");
    const pathMatch = rel.match(/(?:src\/)?pages(\/api\/.*)\.(?:ts|js|tsx|jsx)$/);
    let apiPath = pathMatch ? pathMatch[1] : "/api";
    apiPath = apiPath.replace(/\/index$/, "").replace(/\[([^\]]+)\]/g, ":$1");

    const methods: string[] = [];
    for (const method of HTTP_METHODS) {
      if (content.includes(`req.method === '${method}'`) || content.includes(`req.method === "${method}"`)) {
        methods.push(method);
      }
    }
    if (methods.length === 0) methods.push("ALL");

    for (const method of methods) {
      routes.push({
        method,
        path: apiPath,
        file: rel,
        tags: detectTags(content),
        framework: "next-pages",
      });
    }
  }

  return routes;
}

// --- Hono ---
async function detectHonoRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const tsFiles = files.filter((f) => f.match(/\.(ts|js|tsx|jsx|mjs)$/));
  const routes: RouteInfo[] = [];
  const ts = loadTypeScript(project.root);

  for (const file of tsFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("hono") && !content.includes("Hono")) continue;

    const rel = relative(project.root, file);
    const tags = detectTags(content);

    // Try AST first
    if (ts) {
      const astRoutes = extractRoutesAST(ts, rel, content, "hono", tags);
      if (astRoutes.length > 0) {
        routes.push(...astRoutes);
        continue;
      }
    }

    // Regex fallback
    const routePattern =
      /\.\s*(get|post|put|patch|delete|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const path = match[2];
      if (!path.startsWith("/") && !path.startsWith(":")) continue;
      routes.push({
        method: match[1].toUpperCase(),
        path,
        file: rel,
        tags,
        framework: "hono",
        confidence: "regex",
      });
    }
  }

  return routes;
}

// --- Express ---
async function detectExpressRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const tsFiles = files.filter((f) => f.match(/\.(ts|js|mjs|cjs)$/));
  const routes: RouteInfo[] = [];
  const ts = loadTypeScript(project.root);

  for (const file of tsFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("express") && !content.includes("Router")) continue;

    const rel = relative(project.root, file);
    const tags = detectTags(content);

    // Try AST first
    if (ts) {
      const astRoutes = extractRoutesAST(ts, rel, content, "express", tags);
      if (astRoutes.length > 0) {
        routes.push(...astRoutes);
        continue;
      }
    }

    // Regex fallback
    const routePattern =
      /(?:app|router|server)\s*\.\s*(get|post|put|patch|delete|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file: rel,
        tags,
        framework: "express",
        confidence: "regex",
      });
    }
  }

  return routes;
}

// --- Fastify ---
async function detectFastifyRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const tsFiles = files.filter((f) => f.match(/\.(ts|js|mjs|cjs)$/));
  const routes: RouteInfo[] = [];
  const ts = loadTypeScript(project.root);

  for (const file of tsFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("fastify")) continue;

    const rel = relative(project.root, file);
    const tags = detectTags(content);

    // Try AST first
    if (ts) {
      const astRoutes = extractRoutesAST(ts, rel, content, "fastify", tags);
      if (astRoutes.length > 0) {
        routes.push(...astRoutes);
        continue;
      }
    }

    // Regex fallback
    const routePattern =
      /(?:fastify|server|app)\s*\.\s*(get|post|put|patch|delete|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file: rel,
        tags,
        framework: "fastify",
        confidence: "regex",
      });
    }

    // Object-style route registration
    const objPattern =
      /\.route\s*\(\s*\{[\s\S]*?method:\s*['"`](\w+)['"`][\s\S]*?url:\s*['"`]([^'"`]+)['"`]/gi;
    while ((match = objPattern.exec(content)) !== null) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file: rel,
        tags,
        framework: "fastify",
        confidence: "regex",
      });
    }
  }

  return routes;
}

// --- Koa ---
async function detectKoaRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const tsFiles = files.filter((f) => f.match(/\.(ts|js|mjs|cjs)$/));
  const routes: RouteInfo[] = [];
  const ts = loadTypeScript(project.root);

  for (const file of tsFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("koa") && !content.includes("Router")) continue;

    const rel = relative(project.root, file);
    const tags = detectTags(content);

    if (ts) {
      const astRoutes = extractRoutesAST(ts, rel, content, "koa", tags);
      if (astRoutes.length > 0) {
        routes.push(...astRoutes);
        continue;
      }
    }

    const routePattern =
      /router\s*\.\s*(get|post|put|patch|delete|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file: rel,
        tags,
        framework: "koa",
        confidence: "regex",
      });
    }
  }

  return routes;
}

// --- NestJS ---
async function detectNestJSRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const tsFiles = files.filter((f) => f.match(/\.(ts|js)$/));
  const routes: RouteInfo[] = [];
  const ts = loadTypeScript(project.root);

  for (const file of tsFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("@Controller") && !content.includes("@Get") && !content.includes("@Post")) continue;

    const rel = relative(project.root, file);
    const tags = detectTags(content);

    // Try AST — NestJS benefits most from AST (decorator + controller prefix combining)
    if (ts) {
      const astRoutes = extractRoutesAST(ts, rel, content, "nestjs", tags);
      if (astRoutes.length > 0) {
        routes.push(...astRoutes);
        continue;
      }
    }

    // Regex fallback
    const controllerMatch = content.match(/@Controller\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/);
    const basePath = controllerMatch ? "/" + controllerMatch[1].replace(/^\//, "") : "";

    const decoratorPattern = /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/gi;
    let match;
    while ((match = decoratorPattern.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const subPath = match[2] || "";
      const fullPath = basePath + (subPath ? "/" + subPath.replace(/^\//, "") : "") || "/";
      routes.push({
        method,
        path: fullPath,
        file: rel,
        tags,
        framework: "nestjs",
        confidence: "regex",
      });
    }
  }

  return routes;
}

// --- Elysia (Bun) ---
async function detectElysiaRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const tsFiles = files.filter((f) => f.match(/\.(ts|js|mjs)$/));
  const routes: RouteInfo[] = [];
  const ts = loadTypeScript(project.root);

  for (const file of tsFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("elysia") && !content.includes("Elysia")) continue;

    const rel = relative(project.root, file);
    const tags = detectTags(content);

    if (ts) {
      const astRoutes = extractRoutesAST(ts, rel, content, "elysia", tags);
      if (astRoutes.length > 0) {
        routes.push(...astRoutes);
        continue;
      }
    }

    const routePattern = /\.\s*(get|post|put|patch|delete|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const path = match[2];
      if (!path.startsWith("/") && !path.startsWith(":")) continue;
      routes.push({
        method: match[1].toUpperCase(),
        path,
        file: rel,
        tags,
        framework: "elysia",
        confidence: "regex",
      });
    }
  }

  return routes;
}

// --- AdonisJS ---
async function detectAdonisRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  // AdonisJS uses start/routes.ts with Route.get(), Route.post(), router.get(), etc.
  const routeFiles = files.filter(
    (f) => f.match(/routes\.(ts|js)$/) || f.match(/\/routes\/.*\.(ts|js)$/)
  );
  const routes: RouteInfo[] = [];

  for (const file of routeFiles) {
    const content = await readFileSafe(file);
    const rel = relative(project.root, file);

    const routePattern = /(?:Route|router)\s*\.\s*(get|post|put|patch|delete|any)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      routes.push({
        method: match[1].toUpperCase() === "ANY" ? "ALL" : match[1].toUpperCase(),
        path: match[2],
        file: rel,
        tags: detectTags(content),
        framework: "adonis",
      });
    }
  }

  return routes;
}

// --- tRPC ---
async function detectTRPCRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const tsFiles = files.filter((f) => f.match(/\.(ts|js)$/));
  const routes: RouteInfo[] = [];
  const ts = loadTypeScript(project.root);

  for (const file of tsFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("Procedure") && !content.includes("procedure") && !content.includes("router")) continue;
    if (!content.includes("trpc") && !content.includes("TRPC") && !content.includes("createTRPCRouter") && !content.includes("publicProcedure") && !content.includes("protectedProcedure")) continue;

    const rel = relative(project.root, file);
    const tags = detectTags(content);

    // AST handles tRPC much better — properly parses router nesting and procedure chains
    if (ts) {
      const astRoutes = extractRoutesAST(ts, rel, content, "trpc", tags);
      if (astRoutes.length > 0) {
        routes.push(...astRoutes);
        continue;
      }
    }

    // Regex fallback
    const lines = content.split("\n");
    for (const line of lines) {
      const queryMatch = line.match(/^\s*(\w+)\s*:\s*.*\.(query)\s*\(/);
      const mutationMatch = line.match(/^\s*(\w+)\s*:\s*.*\.(mutation)\s*\(/);
      const m = queryMatch || mutationMatch;
      if (m) {
        const procName = m[1];
        const isQuery = m[2] === "query";
        if (!routes.some((r) => r.path === procName && r.file === rel)) {
          routes.push({
            method: isQuery ? "QUERY" : "MUTATION",
            path: procName,
            file: rel,
            tags,
            framework: "trpc",
            confidence: "regex",
          });
        }
      }
    }
  }

  return routes;
}

// --- SvelteKit ---
async function detectSvelteKitRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  // SvelteKit API routes: src/routes/**/+server.ts
  const routeFiles = files.filter(
    (f) => f.match(/[/\\]routes[/\\].*\+server\.(ts|js)$/)
  );
  const routes: RouteInfo[] = [];

  for (const file of routeFiles) {
    const content = await readFileSafe(file);
    const rel = relative(project.root, file).replace(/\\/g, "/");

    // Extract path from file structure: src/routes/api/users/+server.ts -> /api/users
    const pathMatch = rel.match(/(?:src\/)?routes(.*)\/\+server\./);
    let apiPath = pathMatch ? pathMatch[1] || "/" : "/";
    // Convert [param] to :param
    apiPath = apiPath.replace(/\[([^\]]+)\]/g, ":$1");

    for (const method of HTTP_METHODS) {
      const pattern = new RegExp(
        `export\\s+(?:async\\s+)?function\\s+${method}\\b`
      );
      if (pattern.test(content)) {
        routes.push({
          method,
          path: apiPath,
          file: rel,
          tags: detectTags(content),
          framework: "sveltekit",
        });
      }
    }

    // Also detect: export const GET = ...
    for (const method of HTTP_METHODS) {
      const constPattern = new RegExp(`export\\s+const\\s+${method}\\s*[=:]`);
      if (constPattern.test(content) && !routes.some((r) => r.method === method && r.path === apiPath)) {
        routes.push({
          method,
          path: apiPath,
          file: rel,
          tags: detectTags(content),
          framework: "sveltekit",
        });
      }
    }
  }

  return routes;
}

// --- Remix ---
async function detectRemixRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  // Remix routes: app/routes/*.tsx with loader/action exports
  const routeFiles = files.filter(
    (f) => f.match(/[/\\]routes[/\\].*\.(ts|tsx|js|jsx)$/)
  );
  const routes: RouteInfo[] = [];

  for (const file of routeFiles) {
    const content = await readFileSafe(file);
    const rel = relative(project.root, file).replace(/\\/g, "/");

    // Convert filename to route path
    const pathMatch = rel.match(/(?:app\/)?routes\/(.+)\.(ts|tsx|js|jsx)$/);
    if (!pathMatch) continue;
    let routePath = "/" + pathMatch[1]
      .replace(/\./g, "/")       // dots become path segments
      .replace(/_index$/, "")    // _index -> root of parent
      .replace(/\$/g, ":")       // $param -> :param
      .replace(/\[([^\]]+)\]/g, ":$1");

    if (content.match(/export\s+(?:async\s+)?function\s+loader\b/) || content.match(/export\s+const\s+loader\b/)) {
      routes.push({
        method: "GET",
        path: routePath,
        file: rel,
        tags: detectTags(content),
        framework: "remix",
      });
    }
    if (content.match(/export\s+(?:async\s+)?function\s+action\b/) || content.match(/export\s+const\s+action\b/)) {
      routes.push({
        method: "POST",
        path: routePath,
        file: rel,
        tags: detectTags(content),
        framework: "remix",
      });
    }
  }

  return routes;
}

// --- Nuxt ---
async function detectNuxtRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  // Nuxt server routes: server/api/**/*.ts
  const routeFiles = files.filter(
    (f) => f.match(/[/\\]server[/\\](?:api|routes)[/\\].*\.(ts|js|mjs)$/)
  );
  const routes: RouteInfo[] = [];

  for (const file of routeFiles) {
    const content = await readFileSafe(file);
    const rel = relative(project.root, file).replace(/\\/g, "/");

    // Extract path from file structure
    const pathMatch = rel.match(/server\/((?:api|routes)\/.+)\.(ts|js|mjs)$/);
    if (!pathMatch) continue;
    let routePath = "/" + pathMatch[1]
      .replace(/\/index$/, "")
      .replace(/\[([^\]]+)\]/g, ":$1");

    // Detect method from filename (e.g., users.get.ts, users.post.ts)
    const methodFromFile = basename(file).match(/\.(get|post|put|patch|delete)\.(ts|js|mjs)$/);
    const method = methodFromFile ? methodFromFile[1].toUpperCase() : "ALL";

    // Clean path: remove method suffix from path
    if (methodFromFile) {
      routePath = routePath.replace(new RegExp(`\\.${methodFromFile[1]}$`), "");
    }

    routes.push({
      method,
      path: routePath,
      file: rel,
      tags: detectTags(content),
      framework: "nuxt",
    });
  }

  return routes;
}

// --- FastAPI ---
async function detectFastAPIRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const pyFiles = files.filter((f) => f.endsWith(".py"));
  const routes: RouteInfo[] = [];

  for (const file of pyFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("fastapi") && !content.includes("FastAPI") && !content.includes("APIRouter")) continue;

    const rel = relative(project.root, file);
    const tags = detectTags(content);

    // Try Python AST first
    const astRoutes = await extractPythonRoutesAST(rel, content, "fastapi", tags);
    if (astRoutes && astRoutes.length > 0) {
      routes.push(...astRoutes);
      continue;
    }

    // Fallback to regex
    const routePattern =
      /@\w+\s*\.\s*(get|post|put|patch|delete|options)\s*\(\s*['"]([^'"]+)['"]/gi;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file: rel,
        tags,
        framework: "fastapi",
      });
    }
  }

  return routes;
}

// --- Flask ---
async function detectFlaskRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const pyFiles = files.filter((f) => f.endsWith(".py"));
  const routes: RouteInfo[] = [];

  for (const file of pyFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("flask") && !content.includes("Flask") && !content.includes("Blueprint")) continue;

    const rel = relative(project.root, file);
    const tags = detectTags(content);

    // Try Python AST first
    const astRoutes = await extractPythonRoutesAST(rel, content, "flask", tags);
    if (astRoutes && astRoutes.length > 0) {
      routes.push(...astRoutes);
      continue;
    }

    // Fallback to regex
    const routePattern =
      /@(?:app|bp|blueprint|\w+)\s*\.\s*route\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?\s*\)/gi;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const path = match[1];
      const methods = match[2]
        ? match[2].match(/['"](\w+)['"]/g)?.map((m) => m.replace(/['"]/g, "").toUpperCase()) || ["GET"]
        : ["GET"];

      for (const method of methods) {
        routes.push({
          method,
          path,
          file: rel,
          tags,
          framework: "flask",
        });
      }
    }
  }

  return routes;
}

// --- Django ---
async function detectDjangoRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const pyFiles = files.filter(
    (f) => f.endsWith(".py") && (basename(f) === "urls.py" || basename(f) === "views.py")
  );
  const routes: RouteInfo[] = [];

  for (const file of pyFiles) {
    const content = await readFileSafe(file);
    const rel = relative(project.root, file);
    const tags = detectTags(content);

    // Try Python AST first
    const astRoutes = await extractPythonRoutesAST(rel, content, "django", tags);
    if (astRoutes && astRoutes.length > 0) {
      routes.push(...astRoutes);
      continue;
    }

    // Fallback to regex
    const pathPattern = /path\s*\(\s*['"]([^'"]*)['"]\s*,/g;
    let match;
    while ((match = pathPattern.exec(content)) !== null) {
      routes.push({
        method: "ALL",
        path: "/" + match[1],
        file: rel,
        tags,
        framework: "django",
      });
    }
  }

  return routes;
}

// --- Go (net/http, Gin, Fiber, Echo, Chi) ---
async function detectGoRoutes(
  files: string[],
  project: ProjectInfo,
  fw: Framework
): Promise<RouteInfo[]> {
  const goFiles = files.filter((f) => f.endsWith(".go"));
  const routes: RouteInfo[] = [];

  for (const file of goFiles) {
    const content = await readFileSafe(file);
    const rel = relative(project.root, file);
    const tags = detectTags(content);

    // Use structured parser (brace-tracking + group prefix resolution)
    const structuredRoutes = extractGoRoutesStructured(rel, content, fw, tags);
    if (structuredRoutes.length > 0) {
      routes.push(...structuredRoutes);
      continue;
    }

    // Fallback to simple regex for files where structured parser found nothing
    if (fw === "gin" || fw === "echo") {
      const pattern = /\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*["']([^"']+)["']/g;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        routes.push({ method: match[1], path: match[2], file: rel, tags, framework: fw });
      }
    } else if (fw === "fiber" || fw === "chi") {
      const pattern = /\.\s*(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*["']([^"']+)["']/g;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        routes.push({ method: match[1].toUpperCase(), path: match[2], file: rel, tags, framework: fw });
      }
    } else {
      // net/http
      const pattern = /(?:HandleFunc|Handle)\s*\(\s*["']([^"']+)["']/g;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        // Go 1.22+: "GET /path" patterns
        const pathStr = match[1];
        let method = "ALL";
        let path = pathStr;
        const methodMatch = pathStr.match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/.*)/);
        if (methodMatch) { method = methodMatch[1]; path = methodMatch[2]; }
        routes.push({ method, path, file: rel, tags, framework: fw });
      }
    }
  }

  return routes;
}

// --- Rails ---
async function detectRailsRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const routeFiles = files.filter((f) => f.match(/routes\.rb$/));
  const routes: RouteInfo[] = [];

  for (const file of routeFiles) {
    const content = await readFileSafe(file);
    const rel = relative(project.root, file);

    // get '/users', to: 'users#index'
    const routePattern = /\b(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gi;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file: rel,
        tags: detectTags(content),
        framework: "rails",
      });
    }

    // resources :users (generates RESTful routes)
    const resourcePattern = /resources?\s+:(\w+)/g;
    while ((match = resourcePattern.exec(content)) !== null) {
      const name = match[1];
      for (const [method, suffix] of [
        ["GET", ""], ["GET", "/:id"], ["POST", ""],
        ["PUT", "/:id"], ["PATCH", "/:id"], ["DELETE", "/:id"],
      ] as const) {
        routes.push({
          method,
          path: `/${name}${suffix}`,
          file: rel,
          tags: detectTags(content),
          framework: "rails",
        });
      }
    }
  }

  return routes;
}

// --- Phoenix (Elixir) ---
async function detectPhoenixRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  // Match `router.ex`, files ending in `_routes.ex` (common split pattern),
  // and any `.ex` file inside a directory named `router/` (Phoenix submodules
  // used via `use MyAppWeb.Router.SomeRoutes` macros).
  const routeFiles = files.filter((f) =>
    f.match(/router\.ex$/) ||
    f.match(/_routes\.ex$/) ||
    f.match(/\/router\/[^/]+\.ex$/)
  );
  const routes: RouteInfo[] = [];

  for (const file of routeFiles) {
    const content = await readFileSafe(file);
    const rel = relative(project.root, file);

    // get "/users", UserController, :index
    const routePattern = /\b(get|post|put|patch|delete)\s+["']([^"']+)["']/gi;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file: rel,
        tags: detectTags(content),
        framework: "phoenix",
      });
    }

    // resources "/users", UserController
    const resourcePattern = /resources\s+["']([^"']+)["']/g;
    while ((match = resourcePattern.exec(content)) !== null) {
      const basePath = match[1];
      for (const [method, suffix] of [
        ["GET", ""], ["GET", "/:id"], ["POST", ""],
        ["PUT", "/:id"], ["PATCH", "/:id"], ["DELETE", "/:id"],
      ] as const) {
        routes.push({
          method,
          path: `${basePath}${suffix}`,
          file: rel,
          tags: detectTags(content),
          framework: "phoenix",
        });
      }
    }
  }

  return routes;
}

// --- Spring Boot (Java/Kotlin) ---
async function detectSpringRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const javaFiles = files.filter((f) => f.match(/\.(java|kt)$/));
  const routes: RouteInfo[] = [];

  for (const file of javaFiles) {
    const content = await readFileSafe(file);
    if (!content.includes("@RestController") && !content.includes("@Controller") && !content.includes("@RequestMapping")) continue;

    const rel = relative(project.root, file);

    // Extract class-level @RequestMapping
    const classMapping = content.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
    const basePath = classMapping ? classMapping[1] : "";

    // @GetMapping("/path"), @PostMapping("/path"), etc.
    const mappingPattern = /@(Get|Post|Put|Patch|Delete)Mapping\s*\(\s*(?:value\s*=\s*)?(?:["']([^"']*)["'])?\s*\)/gi;
    let match;
    while ((match = mappingPattern.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const subPath = match[2] || "";
      routes.push({
        method,
        path: basePath + subPath || "/",
        file: rel,
        tags: detectTags(content),
        framework: "spring",
      });
    }

    // @RequestMapping(method = RequestMethod.GET, value = "/path")
    const reqMappingPattern = /@RequestMapping\s*\([^)]*method\s*=\s*RequestMethod\.(\w+)[^)]*value\s*=\s*["']([^"']+)["']/gi;
    while ((match = reqMappingPattern.exec(content)) !== null) {
      routes.push({
        method: match[1].toUpperCase(),
        path: basePath + match[2],
        file: rel,
        tags: detectTags(content),
        framework: "spring",
      });
    }
  }

  return routes;
}

// --- Ktor (Kotlin) ---
async function detectKtorRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const ktFiles = files.filter((f) => f.endsWith(".kt"));
  const routes: RouteInfo[] = [];

  for (const file of ktFiles) {
    const content = await readFileSafe(file);
    if (
      !content.includes("routing") &&
      !content.includes("route(") &&
      !content.includes("get(") &&
      !content.includes("post(")
    ) continue;

    const rel = relative(project.root, file);

    // Track route() prefix nesting: route("/prefix") { get("/sub") { ... } }
    // Strategy: find all route() prefixes, then find method calls inside each block
    const prefixes = new Map<number, string>(); // offset → prefix
    const routeBlockPat = /\.?route\s*\(\s*"([^"]+)"\s*\)\s*\{/g;
    let rm: RegExpExecArray | null;
    while ((rm = routeBlockPat.exec(content)) !== null) {
      prefixes.set(rm.index + rm[0].length, rm[1]);
    }

    // Flat method routes: get("/path") { ... } or post("/path") { ... }
    const methodPat = /\b(get|post|put|patch|delete|head|options)\s*\(\s*"([^"]+)"\s*\)/gi;
    let mm: RegExpExecArray | null;
    while ((mm = methodPat.exec(content)) !== null) {
      const method = mm[1].toUpperCase();
      const path = mm[2];
      const offset = mm.index;

      // Find the closest enclosing route() prefix (largest prefix offset < current offset)
      let prefix = "";
      for (const [pOffset, pPath] of prefixes) {
        if (pOffset <= offset) prefix = pPath;
      }

      routes.push({
        method,
        path: prefix ? normalizePath(prefix + "/" + path) : path,
        file: rel,
        tags: detectTags(content),
        framework: "ktor" as const,
        params: extractKtorParams(path),
        confidence: "regex",
      });
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return routes.filter((r) => {
    const key = `${r.method}:${r.path}:${r.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizePath(path: string): string {
  return ("/" + path).replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function extractKtorParams(path: string): string[] {
  const params: string[] = [];
  const regex = /\{(\w+)\}/g;
  let m;
  while ((m = regex.exec(path)) !== null) params.push(m[1]);
  return params;
}

// --- Rust (Actix-web, Axum) ---
async function detectRustRoutes(
  files: string[],
  project: ProjectInfo,
  fw: Framework
): Promise<RouteInfo[]> {
  const rsFiles = files.filter((f) => f.endsWith(".rs"));
  const routes: RouteInfo[] = [];

  for (const file of rsFiles) {
    const content = await readFileSafe(file);
    const rel = relative(project.root, file);

    if (fw === "actix") {
      // #[get("/path")], #[post("/path")], etc.
      const attrPattern = /#\[(get|post|put|patch|delete)\s*\(\s*"([^"]+)"\s*\)\s*\]/gi;
      let match;
      while ((match = attrPattern.exec(content)) !== null) {
        routes.push({
          method: match[1].toUpperCase(),
          path: match[2],
          file: rel,
          tags: detectTags(content),
          framework: "actix",
        });
      }
      // .route("/path", web::get().to(handler)) or .route("/path", get().to(handler))
      // Handles both web:: prefix and bare method names; .to(handler) is optional
      const routePattern = /\.route\s*\(\s*"([^"]+)"\s*,\s*(?:web::)?(get|post|put|patch|delete)\s*\(\s*\)(?:\.to\s*\([^)]*\))?/gi;
      while ((match = routePattern.exec(content)) !== null) {
        routes.push({
          method: match[2].toUpperCase(),
          path: match[1],
          file: rel,
          tags: detectTags(content),
          framework: "actix",
        });
      }
    } else if (fw === "axum") {
      // .route("/path", get(h)) or .route("/path", get(h).post(h).delete(h))
      // Capture path + the rest of the line (method chain may span same line)
      const routePattern = /\.route\s*\(\s*"([^"]+)"\s*,\s*([^\n]+)/g;
      let match;
      while ((match = routePattern.exec(content)) !== null) {
        const path = match[1];
        const chain = match[2];
        const methodPat = /\b(get|post|put|patch|delete|options|head)\s*\(/gi;
        let mm: RegExpExecArray | null;
        while ((mm = methodPat.exec(chain)) !== null) {
          routes.push({
            method: mm[1].toUpperCase(),
            path,
            file: rel,
            tags: detectTags(content),
            framework: "axum",
          });
        }
      }
    }
  }

  return routes;
}

// --- Raw HTTP (Node.js http.createServer, Deno, Bun.serve) ---
async function detectRawHttpRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const tsFiles = files.filter((f) => f.match(/\.(ts|js|mjs|cjs)$/));
  const routes: RouteInfo[] = [];

  for (const file of tsFiles) {
    const content = await readFileSafe(file);
    // Only scan files that handle HTTP requests
    if (!content.match(/(?:createServer|http\.|req\.|request\.|url|pathname|Bun\.serve|Deno\.serve)/)) continue;

    const rel = relative(project.root, file);

    const patterns = [
      // Direct comparison: url === "/path" or pathname === "/path"
      /(?:url|pathname|parsedUrl\.pathname)\s*===?\s*['"`](\/[a-zA-Z0-9/_:.\-]+)['"`]/g,
      // startsWith: url.startsWith("/api")
      /(?:url|pathname)\s*\.startsWith\s*\(\s*['"`](\/[a-zA-Z0-9/_:.\-]+)['"`]\s*\)/g,
      // Switch case: case "/path":
      /case\s+['"`](\/[a-zA-Z0-9/_:.\-]+)['"`]\s*:/g,
    ];

    const fileTags = detectTags(content);

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const path = match[1];
        // Skip paths that are clearly not routes
        if (path.includes("\\") || path.length > 100 || path.includes("..")) continue;
        // Skip file extensions
        if (path.match(/\.\w{2,4}$/)) continue;

        // Detect method from the same line or immediately adjacent lines (within 100 chars)
        const lineStart = content.lastIndexOf("\n", match.index) + 1;
        const lineEnd = content.indexOf("\n", match.index + match[0].length);
        const lineContext = content.substring(
          Math.max(0, lineStart - 50),
          Math.min(content.length, (lineEnd === -1 ? content.length : lineEnd) + 50)
        );

        let method = "ALL";
        const methodMatch = lineContext.match(/method\s*===?\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/i);
        if (methodMatch) {
          method = methodMatch[1].toUpperCase();
        }

        routes.push({
          method,
          path,
          file: rel,
          tags: fileTags,
          framework: "raw-http",
          confidence: "regex",
        });
      }
    }
  }

  return routes;
}

// --- PHP (front-controller pattern: $routes = [...]) ---
async function detectPHPRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const phpFiles = files.filter((f) => f.endsWith(".php"));
  const routes: RouteInfo[] = [];

  for (const file of phpFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;
    const rel = relative(project.root, file).replace(/\\/g, "/");

    // Pattern 1: $routes = ['/' => [...], '/path' => [...]]
    const routeArrayPattern = /['"](\/[a-zA-Z0-9/_\-{}:.*]*)['"]\s*=>\s*\[/g;
    let match: RegExpExecArray | null;
    while ((match = routeArrayPattern.exec(content)) !== null) {
      const path = match[1];
      if (path.length > 100) continue;
      const ctx = content.substring(Math.max(0, match.index - 200), match.index + 200);
      const methodMatch = ctx.match(/['"]method['"]\s*=>\s*['"](\w+)['"]/i);
      const method = methodMatch ? methodMatch[1].toUpperCase() : "GET";
      routes.push({ method, path, file: rel, tags: detectTags(content), framework: "php" });
    }

    // Pattern 2: router->get('/path'), router->post('/path')
    const routerPattern = /(?:->|::)\s*(get|post|put|patch|delete|any)\s*\(\s*['"](\/[a-zA-Z0-9/_\-{}:.*]*)['"]/gi;
    while ((match = routerPattern.exec(content)) !== null) {
      routes.push({
        method: match[1].toUpperCase() === "ANY" ? "ALL" : match[1].toUpperCase(),
        path: match[2],
        file: rel,
        tags: detectTags(content),
        framework: "php",
      });
    }
  }

  const seen = new Set<string>();
  return routes.filter((r) => {
    const key = `${r.method}:${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Laravel ─────────────────────────────────────────────────────────────────

async function detectLaravelRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  // Laravel routes live in routes/api.php and routes/web.php
  const routeFiles = files.filter(
    (f) =>
      f.endsWith(".php") &&
      (f.match(/[/\\]routes[/\\]/) || basename(f) === "api.php" || basename(f) === "web.php")
  );
  const routes: RouteInfo[] = [];

  for (const file of routeFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;
    const rel = relative(project.root, file).replace(/\\/g, "/");
    const tags = detectTags(content);
    routes.push(...extractLaravelRoutes(rel, content, tags));
  }

  return routes;
}

// ─── ASP.NET Core ─────────────────────────────────────────────────────────────

async function detectAspNetRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const csFiles = files.filter((f) => f.endsWith(".cs"));
  const routes: RouteInfo[] = [];

  for (const file of csFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;
    const rel = relative(project.root, file).replace(/\\/g, "/");
    const tags = detectTags(content);

    // Controller-style: [HttpGet], [Route] on class
    if (
      content.includes("[HttpGet") ||
      content.includes("[HttpPost") ||
      content.includes("[HttpPut") ||
      content.includes("[HttpPatch") ||
      content.includes("[HttpDelete") ||
      content.includes("ControllerBase") ||
      content.includes("Controller")
    ) {
      routes.push(...extractAspNetControllerRoutes(rel, content, tags));
    }

    // Minimal API: app.MapGet(), app.MapPost(), etc. (typically Program.cs)
    if (content.includes(".Map")) {
      routes.push(...extractAspNetMinimalApiRoutes(rel, content, tags));
    }
  }

  const seen = new Set<string>();
  return routes.filter((r) => {
    const key = `${r.method}:${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Flutter (go_router) ─────────────────────────────────────────────────────

async function detectFlutterGoRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const dartFiles = files.filter((f) => f.endsWith(".dart"));
  const routes: RouteInfo[] = [];

  for (const file of dartFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;
    if (!content.includes("GoRoute") && !content.includes("go_router")) continue;
    const rel = relative(project.root, file).replace(/\\/g, "/");
    routes.push(...extractFlutterRoutes(rel, content, detectTags(content)));
  }

  return routes;
}

// ─── Vapor (Swift) ────────────────────────────────────────────────────────────

async function detectVaporRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const swiftFiles = files.filter((f) => f.endsWith(".swift"));
  const routes: RouteInfo[] = [];

  for (const file of swiftFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;
    const rel = relative(project.root, file).replace(/\\/g, "/");
    routes.push(...extractVaporRoutes(rel, content, detectTags(content)));
  }

  return routes;
}

// ─── Android ──────────────────────────────────────────────────────────────────

async function detectAndroidRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const routes: RouteInfo[] = [];

  // 1. Retrofit routes from .kt files
  const ktFiles = files.filter((f) => f.endsWith(".kt"));
  for (const file of ktFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;
    const rel = relative(project.root, file).replace(/\\/g, "/");
    routes.push(...extractRetrofitRoutes(rel, content, detectTags(content)));
  }

  // 2. Navigation XML routes
  const navDirs = [
    join(project.root, "app", "src", "main", "res", "navigation"),
    join(project.root, "src", "main", "res", "navigation"),
  ];
  for (const navDir of navDirs) {
    try {
      const entries = await readdir(navDir);
      for (const entry of entries) {
        if (!entry.endsWith(".xml")) continue;
        const content = await readFileSafe(join(navDir, entry));
        if (!content) continue;
        const rel = relative(project.root, join(navDir, entry)).replace(/\\/g, "/");
        routes.push(...extractNavigationRoutes(rel, content));
      }
    } catch {}
  }

  // 3. Activities from AndroidManifest.xml
  const manifestPaths = [
    join(project.root, "app", "src", "main", "AndroidManifest.xml"),
    join(project.root, "src", "main", "AndroidManifest.xml"),
    join(project.root, "AndroidManifest.xml"),
  ];
  for (const mp of manifestPaths) {
    const content = await readFileSafe(mp);
    if (!content) continue;
    const rel = relative(project.root, mp).replace(/\\/g, "/");
    routes.push(...extractActivitiesFromManifest(rel, content));
    break;
  }

  return routes;
}

// --- Angular ---
async function detectAngularRoutes(
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  const tsFiles = files.filter(
    (f) =>
      f.endsWith(".ts") &&
      !f.includes("node_modules") &&
      !f.endsWith(".spec.ts") &&
      !f.endsWith(".d.ts")
  );
  const routes: RouteInfo[] = [];
  const seen = new Set<string>();

  for (const file of tsFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;
    if (
      !content.includes("Routes") &&
      !content.includes("RouterModule") &&
      !content.includes("provideRouter")
    )
      continue;

    const rel = relative(project.root, file).replace(/\\/g, "/");
    const tags = detectTags(content);

    // Match: { path: 'some/path', ... } entries in route config arrays.
    // Handles single and double quotes.
    const pathPattern = /\bpath\s*:\s*['"]([^'"]*)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = pathPattern.exec(content)) !== null) {
      const routePath = `/${m[1]}`.replace(/\/+/g, "/");
      const key = `GET:${routePath}:${rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({
        method: "GET",
        path: routePath,
        file: rel,
        tags,
        framework: "angular",
        confidence: "regex",
      });
    }
  }

  return routes;
}

// ─── Route Prefix Resolution ──────────────────────────────────────────────────
//
// Problem: sub-router routes are extracted with their HANDLER-LEVEL paths.
// e.g. authRouter.get("/google") shows as GET /google, but is actually GET /auth/google
// because the router is mounted with app.route("/auth", authRouter).
//
// This post-processing step scans main app files for mount registrations and
// patches route paths BEFORE deduplication. Without this, routes from different
// sub-routers with the same handler path (e.g. POST /generate in both cv.py and
// cover_letter.py) collide and one gets silently dropped.

async function resolveRoutePrefixes(
  routes: RouteInfo[],
  files: string[],
  project: ProjectInfo
): Promise<RouteInfo[]> {
  // Build mount graph by scanning ALL source files (not just entry points).
  // This handles multi-level routing: app.ts → routes.ts → auth.ts
  // mountEdges: targetFile → { prefix, mountedBy }
  const mountEdges = new Map<string, { prefix: string; mountedBy: string }>();

  const sourceFiles = files.filter(f => f.match(/\.(ts|js|mjs|cjs|py)$/));

  for (const file of sourceFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;

    const rel = relative(project.root, file).replace(/\\/g, "/");
    const dir = rel.includes("/") ? rel.split("/").slice(0, -1).join("/") : "";

    if (file.endsWith(".py")) {
      if (content.includes("include_router")) {
        parsePythonMountsToGraph(content, dir, files, project, mountEdges, rel);
      }
    } else {
      if (content.includes(".route(") || content.includes(".use(")) {
        parseJSMountsToGraph(content, dir, files, project, mountEdges, rel);
      }
    }
  }

  if (mountEdges.size === 0) return routes;

  // Resolve full prefix for each file by walking up the mount graph.
  // Handles chaining: if app.ts mounts routes.ts at /api, and routes.ts
  // mounts auth.ts at /auth, auth.ts routes get /api/auth prefix.
  const resolvedCache = new Map<string, string>();

  function resolveFullPrefix(file: string, visited: Set<string>): string {
    if (resolvedCache.has(file)) return resolvedCache.get(file)!;
    if (visited.has(file)) return ""; // cycle protection
    visited.add(file);

    const edge = mountEdges.get(file);
    if (!edge) {
      resolvedCache.set(file, "");
      return "";
    }

    const parentPrefix = resolveFullPrefix(edge.mountedBy, new Set(visited));
    const full = (parentPrefix + edge.prefix).replace(/\/\//g, "/");
    resolvedCache.set(file, full);
    return full;
  }

  return routes.map(route => {
    const routeFile = route.file.replace(/\\/g, "/");
    const prefix = resolveFullPrefix(routeFile, new Set());
    if (!prefix || prefix === "/") return route;
    // Don't double-prefix if path already starts with it
    if (route.path.startsWith(prefix + "/") || route.path === prefix) return route;
    const base = prefix.replace(/\/$/, "");
    const newPath = route.path === "/" ? base : base + route.path;
    return { ...route, path: newPath };
  });
}

/** TypeScript/JavaScript: scan ALL files for .route()/.use() mount registrations */
function parseJSMountsToGraph(
  content: string,
  entryDir: string,
  files: string[],
  project: ProjectInfo,
  mountEdges: Map<string, { prefix: string; mountedBy: string }>,
  sourceFile: string
): void {
  // Map: varName → relative source file
  const importMap = new Map<string, string>();

  // Named imports: import { authRoutes, sitesRoutes as sites } from "./routes/auth"
  const namedRe = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = namedRe.exec(content)) !== null) {
    const importPath = m[2];
    const resolved = resolveJSImport(importPath, entryDir, files, project);
    if (!resolved) continue;
    for (const part of m[1].split(",")) {
      const name = (part.includes(" as ") ? part.split(" as ").pop()! : part).trim();
      if (name && /^\w+$/.test(name)) importMap.set(name, resolved);
    }
  }

  // Default imports: import authRoutes from "./routes/auth"
  const defaultRe = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = defaultRe.exec(content)) !== null) {
    const resolved = resolveJSImport(m[2], entryDir, files, project);
    if (resolved) importMap.set(m[1], resolved);
  }

  // CommonJS: const authRoutes = require("./routes/auth")
  const requireRe = /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = requireRe.exec(content)) !== null) {
    const resolved = resolveJSImport(m[2], entryDir, files, project);
    if (resolved) importMap.set(m[1], resolved);
  }

  // app.route("/prefix", varName) or app.use("/prefix", varName)
  const mountRe = /\.\s*(?:route|use)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\w+)/g;
  while ((m = mountRe.exec(content)) !== null) {
    const prefix = m[1];
    const varName = m[2];
    if (!prefix || prefix === "/" || prefix === "*") continue;
    const targetFile = importMap.get(varName);
    if (targetFile && !mountEdges.has(targetFile)) {
      mountEdges.set(targetFile, { prefix, mountedBy: sourceFile });
    }
  }
}

function resolveJSImport(
  importPath: string,
  entryDir: string,
  files: string[],
  project: ProjectInfo
): string | null {
  if (!importPath.startsWith(".")) return null;
  const base = entryDir ? `${entryDir}/${importPath}` : importPath;
  // Normalize: resolve ./ and ..
  const parts = base.split("/");
  const norm: string[] = [];
  for (const p of parts) {
    if (p === "..") norm.pop();
    else if (p !== ".") norm.push(p);
  }
  // Strip any existing extension before trying all variants
  // (TypeScript ESM imports use .js for .ts files: import x from "./foo.js" → foo.ts)
  const stemWithExt = norm.join("/");
  const stem = stemWithExt.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");

  // Try all source extensions
  for (const ext of [".ts", ".tsx", ".js", ".mjs", ".jsx"]) {
    const candidate = `${stem}${ext}`;
    const hit = files.find(f => f.replace(/\\/g, "/").endsWith(candidate));
    if (hit) return relative(project.root, hit).replace(/\\/g, "/");
  }
  // Try /index.ts etc
  for (const ext of [".ts", ".js", ".mjs"]) {
    const candidate = `${stem}/index${ext}`;
    const hit = files.find(f => f.replace(/\\/g, "/").endsWith(candidate));
    if (hit) return relative(project.root, hit).replace(/\\/g, "/");
  }
  return null;
}

/** Python/FastAPI: scan for APIRouter(prefix=...) + include_router() chains */
function parsePythonMountsToGraph(
  content: string,
  _entryDir: string,
  files: string[],
  project: ProjectInfo,
  mountEdges: Map<string, { prefix: string; mountedBy: string }>,
  sourceFile: string
): void {
  // Step 1: Build alias map: "auth_router" → "backend/routes/auth.py"
  //   from routes.auth import router as auth_router
  const aliasRe = /from\s+([\w.]+)\s+import\s+router\s+as\s+(\w+)/g;
  const aliasMap = new Map<string, string>(); // alias → source file
  let m;
  while ((m = aliasRe.exec(content)) !== null) {
    const moduleDots = m[1];
    const alias = m[2];
    const modPath = moduleDots.replace(/\./g, "/");
    const hit = files.find(f => {
      const rel = f.replace(/\\/g, "/");
      return rel.endsWith(`/${modPath}.py`) || rel.endsWith(`${modPath}.py`);
    });
    if (hit) aliasMap.set(alias, relative(project.root, hit).replace(/\\/g, "/"));
  }

  // Also handle: from routes.auth import router (no alias)
  const noAliasRe = /from\s+([\w.]+)\s+import\s+router(?!\s+as)\b/g;
  while ((m = noAliasRe.exec(content)) !== null) {
    const modPath = m[1].replace(/\./g, "/");
    const hit = files.find(f => f.replace(/\\/g, "/").endsWith(`${modPath}.py`));
    if (hit) aliasMap.set("router", relative(project.root, hit).replace(/\\/g, "/"));
  }

  // Step 2: Find APIRouter with prefix: api_router = APIRouter(prefix="/api")
  const prefixRouterRe = /(\w+)\s*=\s*APIRouter\s*\([^)]*prefix\s*=\s*['"]([^'"]+)['"]/g;
  const routerPrefixes = new Map<string, string>(); // varName → prefix
  while ((m = prefixRouterRe.exec(content)) !== null) {
    routerPrefixes.set(m[1], m[2]);
  }

  // Step 3: Chain include_router calls:
  // api_router.include_router(auth_router)
  // api_router.include_router(cv_router, prefix="/cv")
  const includeRe = /(\w+)\s*\.\s*include_router\s*\(\s*(\w+)(?:[^)]*prefix\s*=\s*['"]([^'"]+)['"])?\s*\)/g;
  while ((m = includeRe.exec(content)) !== null) {
    const parentVar = m[1];
    const childVar = m[2];
    const extraPrefix = m[3] || "";
    const parentPrefix = routerPrefixes.get(parentVar) || "";
    const fullPrefix = parentPrefix + extraPrefix;

    const targetFile = aliasMap.get(childVar);
    if (targetFile && fullPrefix && !mountEdges.has(targetFile)) {
      mountEdges.set(targetFile, { prefix: fullPrefix, mountedBy: sourceFile });
    }
  }
}

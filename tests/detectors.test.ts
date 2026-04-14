import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function writeFixture(subdir: string, files: Record<string, string>) {
  const dir = join(FIXTURE_ROOT, subdir);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await mkdir(join(dir, ...name.split("/").slice(0, -1)), { recursive: true });
    await writeFile(filePath, content);
  }
  return dir;
}

// Dynamic import after build
async function loadModules() {
  const { collectFiles, detectProject } = await import("../dist/scanner.js");
  const { detectRoutes } = await import("../dist/detectors/routes.js");
  const { detectSchemas } = await import("../dist/detectors/schema.js");
  const { detectComponents } = await import("../dist/detectors/components.js");
  const { detectDependencyGraph } = await import("../dist/detectors/graph.js");
  const { detectMiddleware } = await import("../dist/detectors/middleware.js");
  const { detectConfig } = await import("../dist/detectors/config.js");
  const { detectLibs } = await import("../dist/detectors/libs.js");
  return { collectFiles, detectProject, detectRoutes, detectSchemas, detectComponents, detectDependencyGraph, detectMiddleware, detectConfig, detectLibs };
}

async function assertFastApiSqlAlchemyDetection(mods: any, dir: string, workspacePath: string, forbiddenWorkspacePaths: string[] = []) {
  const project = await mods.detectProject(dir);
  assert.ok(project.frameworks.includes("fastapi"), `Expected fastapi in frameworks, got ${project.frameworks.join(", ")}`);
  assert.ok(project.orms.includes("sqlalchemy"), `Expected sqlalchemy in ORMs, got ${project.orms.join(", ")}`);
  for (const forbiddenPath of forbiddenWorkspacePaths) {
    assert.ok(!project.workspaces.some((w: any) => w.path === forbiddenPath), `Did not expect workspace ${forbiddenPath}, got ${project.workspaces.map((w: any) => w.path).join(", ")}`);
  }

  const workspace = project.workspaces.find((w: any) => w.path === workspacePath);
  assert.ok(workspace, `Expected workspace ${workspacePath}, got ${project.workspaces.map((w: any) => w.path).join(", ")}`);
  assert.ok(workspace.frameworks.includes("fastapi"), `Expected fastapi in workspace frameworks, got ${workspace.frameworks.join(", ")}`);
  assert.ok(workspace.orms.includes("sqlalchemy"), `Expected sqlalchemy in workspace ORMs, got ${workspace.orms.join(", ")}`);

  const files = await mods.collectFiles(dir);
  const routes = await mods.detectRoutes(files, project);
  const schemas = await mods.detectSchemas(files, project);

  assert.ok(routes.some((r: any) => r.method === "GET" && r.path === "/health"), `Expected GET /health route, got ${routes.map((r: any) => `${r.method} ${r.path}`).join(", ")}`);
  assert.ok(routes.some((r: any) => r.method === "POST" && r.path === "/users"), `Expected POST /users route, got ${routes.map((r: any) => `${r.method} ${r.path}`).join(", ")}`);

  const userSchema = schemas.find((s: any) => s.name === "User");
  const postSchema = schemas.find((s: any) => s.name === "Post");
  assert.ok(userSchema, `Expected User schema, got ${schemas.map((s: any) => s.name).join(", ")}`);
  assert.ok(postSchema, `Expected Post schema, got ${schemas.map((s: any) => s.name).join(", ")}`);
  assert.ok(userSchema.fields.some((f: any) => f.name === "email" && f.flags.includes("unique")));
  assert.ok(postSchema.fields.some((f: any) => f.name === "user_id" && f.flags.includes("fk")));
}

// =================== ROUTE DETECTION TESTS ===================

describe("Route Detection", async () => {
  const mods = await loadModules();

  it("detects Hono routes", async () => {
    const dir = await writeFixture("hono-app", {
      "package.json": JSON.stringify({ name: "test", dependencies: { hono: "^4.0.0" } }),
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/api/users", (c) => c.json([]));
app.post("/api/users", (c) => c.json({}));
app.get("/api/users/:id", (c) => c.json({}));
export default app;`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);
    assert.equal(routes.length, 3);
    assert.ok(routes.some((r: any) => r.method === "GET" && r.path === "/api/users"));
    assert.ok(routes.some((r: any) => r.method === "POST" && r.path === "/api/users"));
    assert.ok(routes.some((r: any) => r.path === "/api/users/:id"));
  });

  it("detects Express routes", async () => {
    const dir = await writeFixture("express-app", {
      "package.json": JSON.stringify({ name: "test", dependencies: { express: "^4.0.0" } }),
      "src/routes.ts": `import { Router } from "express";
const router = Router();
router.get("/users", (req, res) => res.json([]));
router.post("/users", (req, res) => res.json({}));
router.delete("/users/:id", (req, res) => res.json({}));
export default router;`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);
    assert.equal(routes.length, 3);
    assert.ok(routes.some((r: any) => r.method === "DELETE" && r.path === "/users/:id"));
  });

  it("detects Fastify routes", async () => {
    const dir = await writeFixture("fastify-app", {
      "package.json": JSON.stringify({ name: "test", dependencies: { fastify: "^4.0.0" } }),
      "src/server.ts": `import fastify from "fastify";
const app = fastify();
app.get("/health", async () => ({ status: "ok" }));
app.post("/items", async (req) => ({ created: true }));
export default app;`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);
    assert.equal(routes.length, 2);
    assert.ok(routes.some((r: any) => r.method === "GET" && r.path === "/health"));
  });

  it("detects NestJS routes", async () => {
    const dir = await writeFixture("nestjs-app", {
      "package.json": JSON.stringify({ name: "test", dependencies: { "@nestjs/core": "^10.0.0", "@nestjs/common": "^10.0.0" } }),
      "src/users.controller.ts": `import { Controller, Get, Post, Put, Delete, Param } from '@nestjs/common';
@Controller('users')
export class UsersController {
  @Get()
  findAll() { return []; }
  @Get(':id')
  findOne(@Param('id') id: string) { return {}; }
  @Post()
  create() { return {}; }
  @Delete(':id')
  remove(@Param('id') id: string) { return {}; }
}`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);
    assert.equal(routes.length, 4);
    assert.ok(routes.some((r: any) => r.method === "GET" && r.path === "/users"));
    assert.ok(routes.some((r: any) => r.method === "GET" && r.path === "/users/:id"));
    assert.ok(routes.some((r: any) => r.method === "POST" && r.path === "/users"));
    assert.ok(routes.some((r: any) => r.method === "DELETE" && r.path === "/users/:id"));
  });

  it("detects tRPC procedures", async () => {
    const dir = await writeFixture("trpc-app", {
      "package.json": JSON.stringify({ name: "test", dependencies: { "@trpc/server": "^10.0.0" } }),
      "src/router.ts": `import { publicProcedure, createTRPCRouter } from "./trpc";
export const userRouter = createTRPCRouter({
  list: publicProcedure.query(async () => []),
  create: publicProcedure.input(z.object({ name: z.string() })).mutation(async ({ input }) => ({})),
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => ({})),
});`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);
    assert.ok(routes.length >= 3, `Expected >= 3 tRPC procedures, got ${routes.length}`);
    assert.ok(routes.some((r: any) => r.path === "list" && r.method === "QUERY"));
    assert.ok(routes.some((r: any) => r.path === "create" && r.method === "MUTATION"));
  });

  it("detects SvelteKit routes", async () => {
    const dir = await writeFixture("sveltekit-app", {
      "package.json": JSON.stringify({ name: "test", dependencies: { "@sveltejs/kit": "^2.0.0" } }),
      "src/routes/api/users/+server.ts": `export async function GET() {
  return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
}
export async function POST({ request }) {
  return new Response(JSON.stringify({}));
}`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);
    assert.equal(routes.length, 2);
    assert.ok(routes.some((r: any) => r.method === "GET" && r.path === "/api/users"));
    assert.ok(routes.some((r: any) => r.method === "POST" && r.path === "/api/users"));
  });

  it("detects Remix loaders and actions", async () => {
    const dir = await writeFixture("remix-app", {
      "package.json": JSON.stringify({ name: "test", dependencies: { "@remix-run/node": "^2.0.0" } }),
      "app/routes/users.tsx": `export async function loader({ request }) {
  return json([]);
}
export async function action({ request }) {
  return json({});
}`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);
    assert.equal(routes.length, 2);
    assert.ok(routes.some((r: any) => r.method === "GET" && r.path === "/users"));
    assert.ok(routes.some((r: any) => r.method === "POST" && r.path === "/users"));
  });

  it("detects Nuxt server routes", async () => {
    const dir = await writeFixture("nuxt-app", {
      "package.json": JSON.stringify({ name: "test", dependencies: { nuxt: "^3.0.0" } }),
      "server/api/users.get.ts": `export default defineEventHandler(() => []);`,
      "server/api/users.post.ts": `export default defineEventHandler(() => ({}));`,
      "server/api/users/[id].get.ts": `export default defineEventHandler(() => ({}));`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);
    assert.equal(routes.length, 3);
    assert.ok(routes.some((r: any) => r.method === "GET" && r.path.includes("/api/users")));
    assert.ok(routes.some((r: any) => r.method === "POST"));
  });

  it("detects Next.js App Router routes", async () => {
    const dir = await writeFixture("next-app", {
      "package.json": JSON.stringify({ name: "test", dependencies: { next: "^14.0.0" } }),
      "src/app/api/users/route.ts": `export async function GET() {
  return Response.json([]);
}
export async function POST(request: Request) {
  return Response.json({});
}`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);
    assert.equal(routes.length, 2);
    assert.ok(routes.some((r: any) => r.method === "GET" && r.path === "/api/users"));
    assert.ok(routes.some((r: any) => r.method === "POST" && r.path === "/api/users"));
  });

  it("detects FastAPI routes", async () => {
    const dir = await writeFixture("fastapi-app", {
      "requirements.txt": "fastapi\nuvicorn\n",
      "main.py": `from fastapi import FastAPI
app = FastAPI()
@app.get("/users")
def get_users():
    return []
@app.post("/users")
def create_user():
    return {}`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);
    assert.equal(routes.length, 2);
    assert.ok(routes.some((r: any) => r.method === "GET" && r.path === "/users"));
  });

  it("detects Django URL patterns", async () => {
    const dir = await writeFixture("django-app", {
      "requirements.txt": "django\n",
      "urls.py": `from django.urls import path
urlpatterns = [
    path("api/users/", views.UserList.as_view()),
    path("api/users/<int:id>/", views.UserDetail.as_view()),
]`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);
    assert.equal(routes.length, 2);
  });

  it("detects Elysia routes", async () => {
    const dir = await writeFixture("elysia-app", {
      "package.json": JSON.stringify({ name: "test", dependencies: { elysia: "^1.0.0" } }),
      "src/index.ts": `import { Elysia } from "elysia";
const app = new Elysia()
  .get("/api/health", () => "ok")
  .post("/api/items", () => ({ created: true }));`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);
    assert.equal(routes.length, 2);
    assert.ok(routes.some((r: any) => r.method === "GET" && r.path === "/api/health"));
  });

  it("detects raw HTTP routes", async () => {
    const dir = await writeFixture("raw-http-app", {
      "package.json": JSON.stringify({ name: "test" }),
      "src/server.ts": `import { createServer } from "http";
const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://localhost").pathname;
  if (url === "/health") { res.end("ok"); return; }
  if (url === "/api/users" && req.method === "GET") { res.end("[]"); return; }
  if (url === "/api/users" && req.method === "POST") { res.end("{}"); return; }
});`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);
    assert.ok(routes.length >= 2, `Expected >= 2 raw-http routes, got ${routes.length}`);
  });
});

// =================== SCHEMA DETECTION TESTS ===================

describe("Schema Detection", async () => {
  const mods = await loadModules();

  it("detects Drizzle schema", async () => {
    const dir = await writeFixture("drizzle-schema", {
      "package.json": JSON.stringify({ name: "test", dependencies: { "drizzle-orm": "^0.30.0" } }),
      "src/schema.ts": `import { pgTable, text, uuid, timestamp, boolean } from "drizzle-orm/pg-core";
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  active: boolean("active").default(true),
});
export const posts = pgTable("posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  userId: uuid("user_id").references(() => users.id),
});`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const schemas = await mods.detectSchemas(files, project);
    assert.equal(schemas.length, 2);
    assert.ok(schemas.some((s: any) => s.name === "users"));
    assert.ok(schemas.some((s: any) => s.name === "posts"));
    const usersSchema = schemas.find((s: any) => s.name === "users");
    assert.ok(usersSchema!.fields.some((f: any) => f.name === "email" && f.flags.includes("unique")));
  });

  it("detects Prisma schema", async () => {
    const dir = await writeFixture("prisma-schema", {
      "package.json": JSON.stringify({ name: "test", dependencies: { prisma: "^5.0.0" } }),
      "prisma/schema.prisma": `model User {
  id    String @id @default(cuid())
  email String @unique
  name  String
  posts Post[]
}
model Post {
  id     String @id @default(cuid())
  title  String
  userId String
  user   User   @relation(fields: [userId], references: [id])
}`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const schemas = await mods.detectSchemas(files, project);
    assert.ok(schemas.length >= 2);
  });
});

// =================== COMPONENT DETECTION TESTS ===================

describe("Component Detection", async () => {
  const mods = await loadModules();

  it("detects React components with props", async () => {
    const dir = await writeFixture("react-app", {
      "package.json": JSON.stringify({ name: "test", dependencies: { react: "^18.0.0" } }),
      "src/UserProfile.tsx": `export default function UserProfile({ name, email, avatar }: { name: string; email: string; avatar?: string }) {
  return <div>{name} - {email}</div>;
}`,
      "src/ProjectCard.tsx": `export const ProjectCard = ({ title, description }: { title: string; description: string }) => {
  return <div><h2>{title}</h2><p>{description}</p></div>;
};`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const components = await mods.detectComponents(files, project);
    assert.ok(components.length >= 2);
    assert.ok(components.some((c: any) => c.name === "UserProfile" && c.props.includes("name")));
  });
});

// =================== DEPENDENCY GRAPH TESTS ===================

describe("Dependency Graph", async () => {
  const mods = await loadModules();

  it("detects import edges and hot files", async () => {
    const dir = await writeFixture("graph-app", {
      "package.json": JSON.stringify({ name: "test", dependencies: { hono: "^4.0.0" } }),
      "src/db.ts": `export const db = {};`,
      "src/auth.ts": `import { db } from "./db.js";
export const auth = {};`,
      "src/routes.ts": `import { db } from "./db.js";
import { auth } from "./auth.js";
export const routes = {};`,
      "src/middleware.ts": `import { auth } from "./auth.js";
import { db } from "./db.js";
export const mw = {};`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const graph = await mods.detectDependencyGraph(files, project);
    assert.ok(graph.edges.length >= 4, `Expected >= 4 edges, got ${graph.edges.length}`);
    assert.ok(graph.hotFiles.length >= 2, `Expected >= 2 hot files, got ${graph.hotFiles.length}`);
    // db.ts should be the hottest file (imported by 3 files)
    assert.ok(graph.hotFiles[0].file.includes("db"), `Expected db to be hottest, got ${graph.hotFiles[0].file}`);
  });

  it("resolves .js imports to .ts files", async () => {
    const dir = await writeFixture("js-imports", {
      "package.json": JSON.stringify({ name: "test" }),
      "src/utils.ts": `export const helper = () => {};`,
      "src/main.ts": `import { helper } from "./utils.js";
console.log(helper);`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const graph = await mods.detectDependencyGraph(files, project);
    assert.ok(graph.edges.length >= 1, "Should resolve .js import to .ts file");
  });
});

// =================== CONFIG DETECTION TESTS ===================

describe("Config Detection", async () => {
  const mods = await loadModules();

  it("detects env vars from .env and code", async () => {
    const dir = await writeFixture("config-app", {
      "package.json": JSON.stringify({ name: "test" }),
      ".env.example": `DATABASE_URL=
JWT_SECRET=
PORT=3000`,
      "src/config.ts": `const db = process.env.DATABASE_URL;
const port = process.env.PORT || 3000;`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const config = await mods.detectConfig(files, project);
    assert.ok(config.envVars.length >= 2, `Expected >= 2 env vars, got ${config.envVars.length}`);
    assert.ok(config.envVars.some((e: any) => e.name === "DATABASE_URL"));
  });
});

// =================== MIDDLEWARE DETECTION TESTS ===================

describe("Middleware Detection", async () => {
  const mods = await loadModules();

  it("detects middleware files", async () => {
    const dir = await writeFixture("middleware-app", {
      "package.json": JSON.stringify({ name: "test", dependencies: { express: "^4.0.0" } }),
      "src/middleware/auth.ts": `export function authMiddleware(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: "unauthorized" });
  next();
}`,
      "src/middleware/rate-limit.ts": `export function rateLimiter(req, res, next) {
  // rate limiting logic
  next();
}`,
    });
    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const middleware = await mods.detectMiddleware(files, project);
    assert.ok(middleware.length >= 2, `Expected >= 2 middleware, got ${middleware.length}`);
  });
});

// =================== FRAMEWORK DETECTION TESTS ===================

describe("Framework Detection", async () => {
  const mods = await loadModules();

  it("detects NestJS framework", async () => {
    const dir = await writeFixture("nestjs-detect", {
      "package.json": JSON.stringify({ name: "test", dependencies: { "@nestjs/core": "^10.0.0", "@nestjs/common": "^10.0.0" } }),
    });
    const project = await mods.detectProject(dir);
    assert.ok(project.frameworks.includes("nestjs"));
  });

  it("detects tRPC framework", async () => {
    const dir = await writeFixture("trpc-detect", {
      "package.json": JSON.stringify({ name: "test", dependencies: { "@trpc/server": "^10.0.0" } }),
    });
    const project = await mods.detectProject(dir);
    assert.ok(project.frameworks.includes("trpc"));
  });

  it("detects SvelteKit framework", async () => {
    const dir = await writeFixture("sveltekit-detect", {
      "package.json": JSON.stringify({ name: "test", dependencies: { "@sveltejs/kit": "^2.0.0" } }),
    });
    const project = await mods.detectProject(dir);
    assert.ok(project.frameworks.includes("sveltekit"));
  });

  it("detects Remix framework", async () => {
    const dir = await writeFixture("remix-detect", {
      "package.json": JSON.stringify({ name: "test", dependencies: { "@remix-run/node": "^2.0.0" } }),
    });
    const project = await mods.detectProject(dir);
    assert.ok(project.frameworks.includes("remix"));
  });

  it("detects Nuxt framework", async () => {
    const dir = await writeFixture("nuxt-detect", {
      "package.json": JSON.stringify({ name: "test", dependencies: { nuxt: "^3.0.0" } }),
    });
    const project = await mods.detectProject(dir);
    assert.ok(project.frameworks.includes("nuxt"));
  });

  it("detects Elysia framework", async () => {
    const dir = await writeFixture("elysia-detect", {
      "package.json": JSON.stringify({ name: "test", dependencies: { elysia: "^1.0.0" } }),
    });
    const project = await mods.detectProject(dir);
    assert.ok(project.frameworks.includes("elysia"));
  });

  it("detects monorepo", async () => {
    const dir = await writeFixture("monorepo-detect", {
      "package.json": JSON.stringify({ name: "test", workspaces: ["packages/*"] }),
      "packages/api/package.json": JSON.stringify({ name: "@test/api", dependencies: { hono: "^4.0.0", "drizzle-orm": "^0.30.0" } }),
      "packages/web/package.json": JSON.stringify({ name: "@test/web", dependencies: { react: "^18.0.0" } }),
    });
    const project = await mods.detectProject(dir);
    assert.equal(project.isMonorepo, true);
    assert.equal(project.repoType, "monorepo");
    assert.ok(project.workspaces.length >= 2);
    assert.ok(project.frameworks.includes("hono"));
    assert.equal(project.componentFramework, "react");
  });
});

describe("Repo Type Classification", async () => {
  const mods = await loadModules();

  it("classifies single-project repo as 'single'", async () => {
    const dir = await writeFixture("repotype-single", {
      "package.json": JSON.stringify({ name: "my-app", dependencies: { express: "^4.0.0" } }),
    });
    const project = await mods.detectProject(dir);
    assert.equal(project.repoType, "single");
    assert.equal(project.isMonorepo, false);
  });

  it("classifies meta-repo via .gitmodules", async () => {
    const dir = await writeFixture("repotype-meta", {
      ".gitmodules": `[submodule "frontend-app"]\n\tpath = frontend-app\n\turl = https://github.com/org/frontend-app\n[submodule "backend-api"]\n\tpath = backend-api\n\turl = https://github.com/org/backend-api\n`,
      "frontend-app/package.json": JSON.stringify({ name: "frontend-app", dependencies: { react: "^18.0.0" } }),
      "backend-api/package.json": JSON.stringify({ name: "backend-api", dependencies: { express: "^4.0.0" } }),
    });
    const project = await mods.detectProject(dir);
    assert.equal(project.repoType, "meta");
  });

  it("classifies microservices repo via multiple Dockerfiles", async () => {
    const dir = await writeFixture("repotype-microservices-docker", {
      "auth/package.json": JSON.stringify({ name: "auth-service", dependencies: { express: "^4.0.0" } }),
      "auth/Dockerfile": "FROM node:20\nCMD [\"node\", \"index.js\"]",
      "payments/package.json": JSON.stringify({ name: "payments-service", dependencies: { fastify: "^4.0.0" } }),
      "payments/Dockerfile": "FROM node:20\nCMD [\"node\", \"index.js\"]",
    });
    const project = await mods.detectProject(dir);
    assert.equal(project.repoType, "microservices");
    assert.equal(project.isMonorepo, true);
  });

  it("classifies microservices repo via k8s directory", async () => {
    const dir = await writeFixture("repotype-microservices-k8s", {
      "k8s/deployment.yaml": "apiVersion: apps/v1\nkind: Deployment",
      "api/package.json": JSON.stringify({ name: "api", dependencies: { hono: "^4.0.0" } }),
      "worker/package.json": JSON.stringify({ name: "worker", dependencies: { bullmq: "^5.0.0" } }),
    });
    const project = await mods.detectProject(dir);
    assert.equal(project.repoType, "microservices");
  });
});

describe("Python Workspace Subdirectory Detection", async () => {
  const mods = await loadModules();

  it("detects FastAPI and SQLAlchemy in a custom-named root subdirectory", async () => {
    const dir = await writeFixture("python-custom-subdir-root", {
      "package.json": JSON.stringify({ name: "test", dependencies: { react: "^18.0.0" } }),
      "src/App.tsx": `export default function App() { return <main>web</main>; }`,
      "my-service-api/requirements.txt": "fastapi\nsqlalchemy\nuvicorn\n",
      "my-service-api/main.py": `from fastapi import FastAPI
app = FastAPI()

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/users")
def create_user():
    return {"created": True}
`,
      "my-service-api/models.py": `from sqlalchemy import Column, ForeignKey, Integer, String
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    email = Column(String, unique=True)
    posts = relationship("Post")

class Post(Base):
    __tablename__ = "posts"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    user = relationship("User")
`,
    });

    await assertFastApiSqlAlchemyDetection(mods, dir, "my-service-api");
  });

  it("detects FastAPI and SQLAlchemy in a custom-named services workspace", async () => {
    const dir = await writeFixture("python-custom-subdir-workspaces", {
      "package.json": JSON.stringify({ name: "test", workspaces: ["apps/*", "services/*"] }),
      "apps/web/package.json": JSON.stringify({ name: "@test/web", dependencies: { react: "^18.0.0" } }),
      "apps/web/src/App.tsx": `export default function App() { return <main>web</main>; }`,
      "services/my-backend-service/requirements.txt": "fastapi\nsqlalchemy\nuvicorn\n",
      "services/my-backend-service/main.py": `from fastapi import FastAPI
app = FastAPI()

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/users")
def create_user():
    return {"created": True}
`,
      "services/my-backend-service/models.py": `from sqlalchemy import Column, ForeignKey, Integer, String
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    email = Column(String, unique=True)
    posts = relationship("Post")

class Post(Base):
    __tablename__ = "posts"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    user = relationship("User")
`,
    });

    const project = await mods.detectProject(dir);
    assert.equal(project.isMonorepo, true);
    await assertFastApiSqlAlchemyDetection(mods, dir, "services/my-backend-service", ["services"]);
  });

  it("detects FastAPI and SQLAlchemy from pyproject.toml in a custom workspace directory", async () => {
    const dir = await writeFixture("python-custom-subdir-pyproject", {
      "package.json": JSON.stringify({ name: "test", workspaces: ["apps/*", "services/*"] }),
      "apps/web/package.json": JSON.stringify({ name: "@test/web", dependencies: { react: "^18.0.0" } }),
      "services/custom-api/pyproject.toml": `[project]
name = "custom-api"
version = "0.1.0"
dependencies = [
  "fastapi>=0.110.0",
  "sqlalchemy>=2.0.0",
  "uvicorn>=0.29.0",
]
`,
      "services/custom-api/main.py": `from fastapi import FastAPI
app = FastAPI()

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/users")
def create_user():
    return {"created": True}
`,
      "services/custom-api/models.py": `from sqlalchemy import Column, ForeignKey, Integer, String
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    email = Column(String, unique=True)
    posts = relationship("Post")

class Post(Base):
    __tablename__ = "posts"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    user = relationship("User")
`,
    });

    await assertFastApiSqlAlchemyDetection(mods, dir, "services/custom-api", ["services"]);
  });

  it("detects an undeclared FastAPI backend nested under a container directory in a declared monorepo", async () => {
    const dir = await writeFixture("python-nested-container-backend", {
      "package.json": JSON.stringify({ name: "test", workspaces: ["apps/*"] }),
      "apps/web/package.json": JSON.stringify({ name: "@test/web", dependencies: { react: "^18.0.0" } }),
      "apps/web/src/App.tsx": `export default function App() { return <main>web</main>; }`,
      "container-dir/custom-python-backend/requirements.txt": "fastapi\nsqlalchemy\nuvicorn\n",
      "container-dir/custom-python-backend/main.py": `from fastapi import FastAPI
app = FastAPI()

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/users")
def create_user():
    return {"created": True}
`,
      "container-dir/custom-python-backend/models.py": `from sqlalchemy import Column, ForeignKey, Integer, String
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    email = Column(String, unique=True)
    posts = relationship("Post")

class Post(Base):
    __tablename__ = "posts"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    user = relationship("User")
`,
    });

    await assertFastApiSqlAlchemyDetection(mods, dir, "container-dir/custom-python-backend", ["container-dir"]);
  });
});

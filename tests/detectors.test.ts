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
  const { detectEvents } = await import("../dist/detectors/events.js");
  const { detectComponents } = await import("../dist/detectors/components.js");
  const { detectDependencyGraph } = await import("../dist/detectors/graph.js");
  const { detectMiddleware } = await import("../dist/detectors/middleware.js");
  const { detectConfig } = await import("../dist/detectors/config.js");
  const { detectLibs } = await import("../dist/detectors/libs.js");
  return { collectFiles, detectProject, detectRoutes, detectSchemas, detectEvents, detectComponents, detectDependencyGraph, detectMiddleware, detectConfig, detectLibs };
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

  it("detects Celery framework from requirements.txt", async () => {
    const dir = await writeFixture("celery-detect", {
      "requirements.txt": "celery\nredis\n",
      "tasks.py": `from celery import Celery
app = Celery("worker")

@app.task
def ping():
    return "pong"
`,
    });
    const project = await mods.detectProject(dir);
    assert.ok(project.frameworks.includes("celery"));
    assert.equal(project.language, "python");
  });

  it("detects Celery framework from pyproject.toml", async () => {
    const dir = await writeFixture("celery-pyproject-detect", {
      "pyproject.toml": `[project]
name = "celery-worker"
dependencies = [
  "celery>=5.4.0",
  "redis>=5.0.0",
]
`,
    });
    const project = await mods.detectProject(dir);
    assert.ok(project.frameworks.includes("celery"));
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

describe("Event Detection", async () => {
  const mods = await loadModules();

  it("detects Celery task definitions", async () => {
    const dir = await writeFixture("celery-events", {
      "requirements.txt": "celery\n",
      "tasks.py": `from celery import Celery, shared_task
app = Celery("worker")

@app.task
def add(x, y):
    return x + y

@shared_task
def cleanup():
    return True

@app.task(bind=True, name="billing.report_usage_to_stripe", max_retries=3)
def report_usage_to_stripe_task(self):
    return None
`,
    });

    const project = await mods.detectProject(dir);
    const files = await mods.collectFiles(dir);
    const events = await mods.detectEvents(files, project);

    assert.ok(events.some((e: any) => e.system === "celery" && e.name === "tasks.add" && e.payloadType === "celery-task"));
    assert.ok(events.some((e: any) => e.system === "celery" && e.name === "tasks.cleanup" && e.payloadType === "celery-task"));
    assert.ok(events.some((e: any) => e.system === "celery" && e.name === "billing.report_usage_to_stripe" && e.payloadType === "celery-task"));
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

  it("detects Celery in a custom-named services workspace", async () => {
    const dir = await writeFixture("python-celery-workspace", {
      "package.json": JSON.stringify({ name: "test", workspaces: ["apps/*", "services/*"] }),
      "apps/web/package.json": JSON.stringify({ name: "@test/web", dependencies: { react: "^18.0.0" } }),
      "services/worker-service/requirements.txt": "celery\nredis\n",
      "services/worker-service/tasks.py": `from celery import Celery
app = Celery("worker")

@app.task
def sync_users():
    return True
`,
    });

    const project = await mods.detectProject(dir);
    const workspace = project.workspaces.find((w: any) => w.path === "services/worker-service");
    assert.ok(project.frameworks.includes("celery"), `Expected celery in frameworks, got ${project.frameworks.join(", ")}`);
    assert.ok(workspace, `Expected workspace services/worker-service, got ${project.workspaces.map((w: any) => w.path).join(", ")}`);
    assert.ok(workspace.frameworks.includes("celery"), `Expected celery in workspace frameworks, got ${workspace.frameworks.join(", ")}`);
  });
});

// =================== ROKU / SCENEGRAPH TESTS ===================
//
// Covers the full Roku pipeline: project detection, routes as screens,
// schema from <interface> fields, components from XML, libs from .brs / .bs,
// and dependency edges from <script uri="pkg:/..."> + BrighterScript imports.

const ROKU_MANIFEST = `title=Test Channel\nmajor_version=1\nminor_version=0\nbuild_version=0\nui_resolutions=fhd\n`;

const ROKU_MAIN_SCENE_XML = `<?xml version="1.0" encoding="utf-8" ?>
<component name="MainScene" extends="Scene">
  <children>
    <HomeView id="homeView" />
    <LoginView id="loginView" />
    <ErrorModal id="errorModal" />
  </children>
  <script type="text/brightscript" uri="pkg:/components/MainScene.brs" />
</component>
`;

const ROKU_MAIN_SCENE_BRS = `sub init()
    m.homeView = m.top.findNode("homeView")
    m.loginView = m.top.findNode("loginView")
    m.errorModal = m.top.findNode("errorModal")
    m.top.observeField("someField", "handleSome")
    m.global.AddField("token", "string", false)
    ShowScreen(m.homeView)
end sub

sub showLogin()
    ShowScreen(m.loginView, true)
end sub

sub showError()
    ShowScreen(m.errorModal, true)
end sub
`;

const ROKU_HOME_VIEW_XML = `<?xml version="1.0" encoding="utf-8" ?>
<component name="HomeView" extends="Group">
  <interface>
    <field id="pageID" type="String" />
    <field id="channelID" type="String" />
  </interface>
  <script type="text/brightscript" uri="pkg:/components/views/HomeView.brs" />
</component>
`;

const ROKU_HOME_VIEW_BRS = `sub init()
end sub
`;

const ROKU_LOGIN_VIEW_XML = `<?xml version="1.0" encoding="utf-8" ?>
<component name="LoginView" extends="Group">
  <interface>
    <field id="email" type="String" />
  </interface>
  <script type="text/brightscript" uri="pkg:/components/views/LoginView.brs" />
</component>
`;

const ROKU_LOGIN_VIEW_BRS = `sub init()
end sub
`;

const ROKU_ERROR_MODAL_XML = `<?xml version="1.0" encoding="utf-8" ?>
<component name="ErrorModal" extends="Group">
  <interface>
    <field id="message" type="String" />
  </interface>
</component>
`;

const ROKU_DATA_TASK_XML = `<?xml version="1.0" encoding="utf-8" ?>
<component name="DataTask" extends="Task">
  <interface>
    <field id="requestUrl" type="String" />
    <field id="response" type="assocarray" />
  </interface>
  <script type="text/brightscript" uri="pkg:/components/tasks/DataTask.brs" />
</component>
`;

const ROKU_DATA_TASK_BRS = `sub init()
    m.top.functionName = "fetchData"
end sub

function fetchData() as object
    response = makeGraphqlCall(m.top.requestUrl, "{}", {})
    return response
end function
`;

const ROKU_UTILS_BRS = `function helperFormat(input as string) as string
    return input
end function

sub helperLog(msg as string)
    print msg
end sub
`;

const ROKU_HELPERS_BS = `import "pkg:/source/utils/Utils.brs"

namespace app.helpers
end namespace

class RokuHelper
    function sayHi() as string
        return "hi"
    end function
end class
`;

describe("Roku SceneGraph Detection", async () => {
  const mods = await loadModules();

  it("detects a kernel-roku-style single-channel project from <children> alone (no ShowScreen helper)", async () => {
    // 90% of Roku repos look like this: manifest at root, source/ + components/,
    // no custom navigation helper. The route surface comes entirely from
    // MainScene.xml's <children> slots.
    const dir = await writeFixture("roku-standard-channel", {
      "manifest": ROKU_MANIFEST,
      "source/Main.brs": `sub Main()
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)
    scene = screen.CreateScene("MainScene")
    screen.show()
    while true
        msg = wait(0, port)
        msgType = type(msg)
        if msgType = "roSGScreenEvent"
            if msg.isScreenClosed() then return
        end if
    end while
end sub
`,
      "components/MainScene.xml": `<?xml version="1.0" encoding="utf-8" ?>
<component name="MainScene" extends="Scene">
  <children>
    <HomeView id="homeView" visible="true" />
    <DetailView id="detailView" visible="false" />
  </children>
  <script type="text/brightscript" uri="pkg:/components/MainScene.brs" />
</component>
`,
      "components/MainScene.brs": `sub init()
    m.homeView = m.top.findNode("homeView")
    m.detailView = m.top.findNode("detailView")
    m.homeView.setFocus(true)
end sub

sub onItemSelected()
    m.homeView.visible = false
    m.detailView.visible = true
    m.detailView.setFocus(true)
end sub
`,
      "components/views/HomeView.xml": `<?xml version="1.0" encoding="utf-8" ?>
<component name="HomeView" extends="Group">
  <interface>
    <field id="items" type="array" />
  </interface>
</component>
`,
      "components/views/DetailView.xml": `<?xml version="1.0" encoding="utf-8" ?>
<component name="DetailView" extends="Group">
  <interface>
    <field id="itemId" type="String" />
  </interface>
</component>
`,
    });

    const project = await mods.detectProject(dir);
    assert.equal(project.language, "brightscript", `language: got ${project.language}`);
    assert.ok(project.frameworks.includes("roku-scenegraph"));
    assert.ok(!project.isMonorepo, "standard single-channel repo must not be flagged as monorepo");

    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);

    // Expect exactly two VIEW routes, derived purely from MainScene <children>.
    // No ShowScreen helper exists in this fixture — the detector must not
    // depend on one.
    assert.equal(routes.length, 2, `expected 2 routes, got ${routes.length}: ${routes.map((r: any) => `${r.method} ${r.path}`).join(", ")}`);
    const home = routes.find((r: any) => r.path === "/homeView");
    const detail = routes.find((r: any) => r.path === "/detailView");
    assert.ok(home, "expected /homeView route");
    assert.equal(home.method, "VIEW");
    assert.ok(home.file.endsWith("HomeView.xml"), `expected HomeView.xml, got ${home.file}`);
    assert.ok(detail, "expected /detailView route");
    assert.equal(detail.method, "VIEW");
    assert.ok(detail.file.endsWith("DetailView.xml"));
  });

  it("detects rokucommunity/brighterscript-template layout (bsconfig.json + src/manifest)", async () => {
    // BrighterScript template: TS tooling at root, actual Roku channel under src/.
    const dir = await writeFixture("roku-brighterscript-template", {
      "package.json": JSON.stringify({
        name: "my-bsc-app",
        devDependencies: { brighterscript: "^0.71.0" },
      }),
      "bsconfig.json": JSON.stringify({ rootDir: "src", files: ["**/*"] }),
      "src/manifest": ROKU_MANIFEST,
      "src/source/Main.brs": `sub Main()\n    screen = CreateObject("roSGScreen")\nend sub\n`,
      "src/source/Utils.bs": `namespace app.utils\n    function greet() as string\n        return "hi"\n    end function\nend namespace\n`,
      "src/components/MainScene.xml": `<?xml version="1.0" encoding="utf-8" ?>
<component name="MainScene" extends="Scene">
  <children>
    <HomeView id="homeView" />
  </children>
</component>
`,
      "src/components/HomeView.xml": `<?xml version="1.0" encoding="utf-8" ?>
<component name="HomeView" extends="Group">
  <interface>
    <field id="title" type="String" />
  </interface>
</component>
`,
    });

    const project = await mods.detectProject(dir);
    // Root must be identified as the Roku channel, not a workspace holder.
    assert.ok(
      project.frameworks.includes("roku-scenegraph"),
      `expected root roku-scenegraph framework, got ${project.frameworks.join(", ")}`
    );
    assert.ok(
      !project.isMonorepo,
      "brighterscript-template is a single-channel project, must not be promoted to monorepo"
    );

    const files = await mods.collectFiles(dir);
    const routes = await mods.detectRoutes(files, project);
    const schemas = await mods.detectSchemas(files, project);
    const components = await mods.detectComponents(files, project);

    assert.ok(routes.some((r: any) => r.path === "/homeView"), `expected /homeView, got ${routes.map((r: any) => r.path).join(", ")}`);
    assert.ok(schemas.some((s: any) => s.name === "HomeView"), `expected HomeView schema, got ${schemas.map((s: any) => s.name).join(", ")}`);
    const mainScene = components.find((c: any) => c.name === "MainScene");
    assert.ok(mainScene, "expected MainScene component");
    assert.ok(mainScene.file.startsWith("src/"), `expected src/-rooted path, got ${mainScene.file}`);
  });

  it("does not promote a standard single-channel repo to a monorepo even when package.json has roku-deploy", async () => {
    // A repo with roku-deploy but no common/ + channels layout is still single-channel.
    const dir = await writeFixture("roku-deploy-single-channel", {
      "manifest": ROKU_MANIFEST,
      "package.json": JSON.stringify({
        name: "single-channel",
        devDependencies: { "roku-deploy": "^3.10.0" },
      }),
      "components/MainScene.xml": `<?xml version="1.0" encoding="utf-8" ?>
<component name="MainScene" extends="Scene"></component>
`,
    });
    const project = await mods.detectProject(dir);
    assert.ok(!project.isMonorepo, "single-channel repo must not be labeled monorepo");
    assert.ok(project.frameworks.includes("roku-scenegraph"));
  });

  it("detects Roku project + routes + schemas + components + libs + graph", async () => {
    const dir = await writeFixture("roku-channel", {
      "manifest": ROKU_MANIFEST,
      "components/MainScene.xml": ROKU_MAIN_SCENE_XML,
      "components/MainScene.brs": ROKU_MAIN_SCENE_BRS,
      "components/views/HomeView.xml": ROKU_HOME_VIEW_XML,
      "components/views/HomeView.brs": ROKU_HOME_VIEW_BRS,
      "components/views/LoginView.xml": ROKU_LOGIN_VIEW_XML,
      "components/views/LoginView.brs": ROKU_LOGIN_VIEW_BRS,
      "components/views/ErrorModal.xml": ROKU_ERROR_MODAL_XML,
      "components/tasks/DataTask.xml": ROKU_DATA_TASK_XML,
      "components/tasks/DataTask.brs": ROKU_DATA_TASK_BRS,
      "source/utils/Utils.brs": ROKU_UTILS_BRS,
      "source/Helpers.bs": ROKU_HELPERS_BS,
    });

    // 1. Project detection
    const project = await mods.detectProject(dir);
    assert.equal(project.language, "brightscript", `expected brightscript language, got ${project.language}`);
    assert.ok(project.frameworks.includes("roku-scenegraph"), `expected roku-scenegraph framework, got ${project.frameworks.join(", ")}`);
    assert.equal(project.componentFramework, "scenegraph", `expected scenegraph componentFramework, got ${project.componentFramework}`);
    assert.ok(project.orms.includes("scenegraph"), `expected scenegraph orm, got ${project.orms.join(", ")}`);

    const files = await mods.collectFiles(dir);

    // 2. Routes: one VIEW per ShowScreen(m.homeView), MODAL for the 2nd-arg-true calls
    const routes = await mods.detectRoutes(files, project);
    const home = routes.find((r: any) => r.path === "/homeView");
    const login = routes.find((r: any) => r.path === "/loginView");
    const err = routes.find((r: any) => r.path === "/errorModal");
    assert.ok(home, `expected /homeView route, got ${routes.map((r: any) => `${r.method} ${r.path}`).join(", ")}`);
    assert.equal(home.method, "VIEW", `expected VIEW method, got ${home.method}`);
    assert.ok(home.file.endsWith("HomeView.xml"), `expected file HomeView.xml, got ${home.file}`);
    assert.ok(login, `expected /loginView route`);
    assert.equal(login.method, "MODAL", `expected MODAL method, got ${login.method}`);
    assert.ok(err, `expected /errorModal route`);
    assert.equal(err.method, "MODAL");

    // 3. Schemas: HomeView + LoginView + ErrorModal + DataTask (all have <interface>)
    const schemas = await mods.detectSchemas(files, project);
    const names = schemas.map((s: any) => s.name);
    assert.ok(names.includes("HomeView"), `expected HomeView schema, got ${names.join(", ")}`);
    assert.ok(names.includes("DataTask"), `expected DataTask schema, got ${names.join(", ")}`);
    const dataTask = schemas.find((s: any) => s.name === "DataTask");
    assert.equal(dataTask.orm, "scenegraph");
    assert.ok(dataTask.fields.some((f: any) => f.name === "requestUrl" && f.type === "string"));
    assert.ok(dataTask.fields.some((f: any) => f.name === "response" && f.type === "object"));

    // 4. Components: every SceneGraph XML (MainScene, HomeView, LoginView, ErrorModal, DataTask)
    const components = await mods.detectComponents(files, project);
    const compNames = components.map((c: any) => c.name);
    assert.ok(compNames.includes("HomeView"));
    assert.ok(compNames.includes("DataTask"));
    assert.ok(compNames.includes("MainScene"));
    const homeComp = components.find((c: any) => c.name === "HomeView");
    assert.deepEqual(homeComp.props.sort(), ["channelID", "pageID"]);

    // 5. Libs: Utils.brs functions + Helpers.bs class + namespace + folded-in fns
    const libs = await mods.detectLibs(files, project);
    const utilsLib = libs.find((l: any) => l.file.endsWith("Utils.brs"));
    assert.ok(utilsLib, `expected Utils.brs lib, got ${libs.map((l: any) => l.file).join(", ")}`);
    assert.ok(utilsLib.exports.some((e: any) => e.name === "helperFormat" && e.kind === "function"));
    assert.ok(utilsLib.exports.some((e: any) => e.name === "helperLog" && e.kind === "function"));

    const helpersLib = libs.find((l: any) => l.file.endsWith("Helpers.bs"));
    assert.ok(helpersLib, `expected Helpers.bs lib, got ${libs.map((l: any) => l.file).join(", ")}`);
    assert.ok(helpersLib.exports.some((e: any) => e.name === "RokuHelper" && e.kind === "class"));

    // 6. Dependency graph: BrighterScript `import` edge + MainScene.xml <script uri=...> edges
    const graph = await mods.detectDependencyGraph(files, project);
    const hasImportEdge = graph.edges.some(
      (e: any) => e.from.endsWith("Helpers.bs") && e.to.endsWith("Utils.brs")
    );
    assert.ok(hasImportEdge, `expected Helpers.bs -> Utils.brs edge, got ${graph.edges.map((e: any) => `${e.from}->${e.to}`).join(", ")}`);
    const hasScriptEdge = graph.edges.some(
      (e: any) => e.from.endsWith("MainScene.xml") && e.to.endsWith("MainScene.brs")
    );
    assert.ok(hasScriptEdge, `expected MainScene.xml -> MainScene.brs edge, got ${graph.edges.map((e: any) => `${e.from}->${e.to}`).join(", ")}`);

    // 7. Config: Roku manifest surfaces as env-like vars and shows up in configFiles
    const config = await mods.detectConfig(files, project);
    assert.ok(config.configFiles.includes("manifest"), `expected manifest in configFiles, got ${config.configFiles.join(", ")}`);
    assert.ok(config.envVars.some((e: any) => e.name === "manifest.title"), `expected manifest.title env var, got ${config.envVars.map((e: any) => e.name).join(", ")}`);

    // 8. Middleware: observeField + m.global.AddField show up as custom middleware
    const middleware = await mods.detectMiddleware(files, project);
    assert.ok(
      middleware.some((mw: any) => mw.name.includes("observeField(someField)")),
      `expected observeField middleware, got ${middleware.map((mw: any) => mw.name).join(", ")}`
    );
    assert.ok(
      middleware.some((mw: any) => mw.name === "m.global.token: string"),
      `expected m.global.token middleware, got ${middleware.map((mw: any) => mw.name).join(", ")}`
    );
  });

  it("detects bsconfig.json + source/*.brs layout without a manifest file (Layout 2)", async () => {
    // Enterprise layout: manifest is generated at build time so it is absent
    // from the repo. Detection must fall back to bsconfig.json + source/*.brs.
    const dir = await writeFixture("roku-bsconfig-no-manifest", {
      "package.json": JSON.stringify({
        name: "my-roku-app",
        devDependencies: { brighterscript: "^0.70.3" },
      }),
      "bsconfig.json": JSON.stringify({ rootDir: "" }),
      "source/main.brs": `sub Main()\n    screen = CreateObject("roSGScreen")\nend sub\n`,
      "source/utils/StringUtils.brs": `function trim(s as string) as string\n    return s.trim()\nend function\n`,
      "components/MainScene.xml": `<?xml version="1.0" encoding="utf-8" ?>
<component name="MainScene" extends="Scene">
  <interface>
    <field id="ready" type="boolean" />
  </interface>
</component>
`,
    });

    const project = await mods.detectProject(dir);
    assert.ok(
      project.frameworks.includes("roku-scenegraph"),
      `expected roku-scenegraph, got: ${project.frameworks.join(", ")}`
    );
    assert.equal(project.language, "brightscript", `expected brightscript, got ${project.language}`);
    assert.ok(!project.isMonorepo, "no-manifest channel must not be promoted to monorepo");

    const files = await mods.collectFiles(dir);
    const libs = await mods.detectLibs(files, project);
    assert.ok(
      libs.some((l: any) => l.file.includes("StringUtils.brs")),
      `expected StringUtils.brs in libs, got: ${libs.map((l: any) => l.file).join(", ")}`
    );
  });

  it("detects apmc-roku-style layout: bsconfig.json at root, source/ + components/ subdirs, lib/, no manifest", async () => {
    // Models the actual apmc-roku project: bsconfig.json with rootDir:"",
    // source/ for app code, components/ for SceneGraph XML, lib/ for
    // third-party BRS, and no manifest (generated by build scripts).
    const dir = await writeFixture("roku-apmc-style", {
      "package.json": JSON.stringify({
        name: "apmc-roku",
        devDependencies: {
          brighterscript: "^0.70.3",
          "@rokucommunity/bslint": "^0.8.38",
        },
      }),
      "bsconfig.json": JSON.stringify({ extends: "./configs/brightscript/bsconfig.base.json" }),
      "source/main.brs": `sub Main()\n    screen = CreateObject("roSGScreen")\nend sub\n`,
      "source/utils/NavUtils.brs": `function getNavNode(item as object) as object\n    return invalid\nend function\n`,
      "source/utils/AnalyticsUtils.brs": `function trackEvent(name as string) as void\nend function\n`,
      "lib/rafxssai.brs": `function RafInit() as void\nend function\n`,
      "components/MainScene.xml": `<?xml version="1.0" encoding="utf-8" ?>
<component name="MainScene" extends="Scene">
  <interface>
    <field id="screenManager" type="node" />
    <field id="exitApp" type="boolean" value="false" />
  </interface>
</component>
`,
      "components/MainScene.brs": `sub init()\n    m.top.observeField("exitApp", "onExitApp")\nend sub\nfunction onExitApp() as void\nend function\n`,
      "components/nodes/HomeView.xml": `<?xml version="1.0" encoding="utf-8" ?>
<component name="HomeView" extends="Group">
  <interface>
    <field id="content" type="assocarray" />
  </interface>
</component>
`,
    });

    const project = await mods.detectProject(dir);
    assert.ok(
      project.frameworks.includes("roku-scenegraph"),
      `expected roku-scenegraph, got: ${project.frameworks.join(", ")}`
    );
    assert.equal(project.language, "brightscript", `expected brightscript, got ${project.language}`);
    assert.ok(!project.isMonorepo, "single-channel repo must not be promoted to monorepo");

    const files = await mods.collectFiles(dir);

    // lib/ third-party BRS should appear in libs
    const libs = await mods.detectLibs(files, project);
    assert.ok(
      libs.some((l: any) => l.file.includes("rafxssai.brs")),
      `expected lib/rafxssai.brs in libs, got: ${libs.map((l: any) => l.file).join(", ")}`
    );
    assert.ok(
      libs.some((l: any) => l.file.includes("NavUtils.brs")),
      `expected NavUtils.brs in libs, got: ${libs.map((l: any) => l.file).join(", ")}`
    );

    // observeField in MainScene.brs should surface as middleware
    const middleware = await mods.detectMiddleware(files, project);
    assert.ok(
      middleware.some((mw: any) => mw.name.includes("observeField(exitApp)")),
      `expected observeField(exitApp) middleware, got: ${middleware.map((mw: any) => mw.name).join(", ")}`
    );

    // HomeView schema from nodes/ subdirectory
    const schemas = await mods.detectSchemas(files, project);
    assert.ok(
      schemas.some((s: any) => s.name === "HomeView"),
      `expected HomeView schema, got: ${schemas.map((s: any) => s.name).join(", ")}`
    );
  });
});

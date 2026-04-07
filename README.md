<div align="center">

### Your AI assistant wastes thousands of tokens every conversation just figuring out your project. codesight fixes that in one command.

**Zero dependencies. AST precision. 25+ framework detectors. 8 ORM parsers. 8 MCP tools. One `npx` call.**

**Works with TypeScript, JavaScript, Python, Go, Ruby, Elixir, Java, Kotlin, Rust, and PHP.** TypeScript projects get full AST precision. Everything else uses battle-tested regex detection across the same 25+ frameworks.

[![npm version](https://img.shields.io/npm/v/codesight?style=for-the-badge&logo=npm&color=CB3837)](https://www.npmjs.com/package/codesight)
[![npm downloads](https://img.shields.io/npm/dm/codesight?style=for-the-badge&logo=npm&color=blue&label=Monthly%20Downloads)](https://www.npmjs.com/package/codesight)
[![npm total](https://img.shields.io/npm/dt/codesight?style=for-the-badge&logo=npm&color=cyan&label=Total%20Downloads)](https://www.npmjs.com/package/codesight)
[![GitHub stars](https://img.shields.io/github/stars/Houseofmvps/codesight?style=for-the-badge&logo=github&color=gold)](https://github.com/Houseofmvps/codesight/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge&logo=opensourceinitiative)](LICENSE)

---

[![Follow @kaileskkhumar](https://img.shields.io/badge/Follow%20%40kaileskkhumar-000000?style=for-the-badge&logo=x&logoColor=white)](https://x.com/kaileskkhumar)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Connect-0A66C2?style=for-the-badge&logo=linkedin)](https://www.linkedin.com/in/kailesk-khumar)
[![houseofmvps.com](https://img.shields.io/badge/houseofmvps.com-Website-green?style=for-the-badge&logo=google-chrome&logoColor=white)](https://houseofmvps.com)

**Built by [Kailesk Khumar](https://www.linkedin.com/in/kailesk-khumar), solo founder of [houseofmvps.com](https://houseofmvps.com)**

*Also: [ultraship](https://github.com/Houseofmvps/ultraship) (39 expert skills for Claude Code) · [claude-rank](https://github.com/Houseofmvps/claude-rank) (SEO/GEO/AEO plugin for Claude Code)*

</div>

---

```
0 dependencies · Node.js >= 18 · 27 tests · 8 MCP tools · MIT
```

## Works With

**Claude Code, Cursor, GitHub Copilot, OpenAI Codex, Windsurf, Cline, Aider**, and anything that reads markdown.

## Install

```bash
npx codesight
```

That's it. Run it in any project root. No config, no setup, no API keys.

```bash
npx codesight --init                # Generate CLAUDE.md, .cursorrules, codex.md, AGENTS.md
npx codesight --open                # Open interactive HTML report in browser
npx codesight --mcp                 # Start as MCP server (8 tools) for Claude Code / Cursor
npx codesight --blast src/lib/db.ts # Show blast radius for a file
npx codesight --profile claude-code # Generate optimized config for a specific AI tool
npx codesight --benchmark           # Show detailed token savings breakdown
```

## Benchmarks (Real Projects)

Every number below comes from running `codesight v1.3.1` on real production codebases. No estimates, no hypotheticals.

| Project | Stack | Files | Routes | Models | Components | Output Tokens | Exploration Tokens | Savings | Scan Time |
|---|---|---|---|---|---|---|---|---|---|
| **SaaS A** | Hono + Drizzle, 4 workspaces | 92 | 60 | 18 | 16 | 5,129 | 66,040 | **12.9x** | 290ms |
| **SaaS B** | raw HTTP + Drizzle | 53 | 38 | 12 | 0 | 3,945 | 46,020 | **11.7x** | 185ms |
| **SaaS C** | Hono + Drizzle, 3 workspaces | 40 | 13 | 8 | 10 | 2,865 | 26,130 | **9.1x** | 260ms |

**Average: 11.2x token reduction.** Your AI reads ~3K-5K tokens instead of burning ~26K-66K exploring files.

![Token comparison: Without codesight (46K-66K tokens) vs With codesight (3K-5K tokens)](assets/token-comparison.jpg)

### AST Accuracy

When TypeScript is available, codesight uses the TypeScript compiler API for structural parsing.

| Project | AST Routes | AST Models | AST Components | False Positives |
|---|---|---|---|---|
| **SaaS A** | 60/60 (100%) | 18/18 (100%) | 16/16 (100%) | 0 |
| **SaaS B** | 0/38 (regex fallback) | 12/12 (100%) | n/a | 0 |
| **SaaS C** | 13/13 (100%) | 8/8 (100%) | 10/10 (100%) | 0 |

SaaS B uses raw `http.createServer` which has no framework structure for AST to parse. codesight correctly falls back to regex for routes while still using AST for Drizzle schema. Zero false positives across all three projects.

### Blast Radius Accuracy

Tested on a production SaaS: changing the database module correctly identified:

- **10 affected files** across API, auth, background jobs, and server layers
- **33 affected routes** (every endpoint that touches the database)
- **12 affected models** (all schema models)
- **BFS depth:** 3 hops through the import graph

### What Gets Detected

Measured across the three benchmark projects:

| Detector | SaaS A (92 files) | SaaS B (53 files) | SaaS C (40 files) |
|---|---|---|---|
| **Routes** | 60 | 38 | 13 |
| **Schema models** | 18 | 12 | 8 |
| **Components** | 16 | 0 | 10 |
| **Library exports** | 36 | 32 | 11 |
| **Env vars** | 22 | 26 | 12 |
| **Middleware** | 5 | 3 | 2 |
| **Import links** | 295 | 101 | 76 |
| **Hot files** | 20 | 20 | 20 |

---

## How It Works

![How codesight works: Codebase → AST Parser + Regex Fallback → Context Map → CLAUDE.md, .cursorrules, codex.md, MCP Server](assets/how-it-works.jpg)

![8 parallel detectors: Routes, Schema, Components, Dep Graph, Middleware, Config, Libraries, Contracts](assets/detectors.jpg)

codesight runs all 8 detectors in parallel, then writes the results as structured markdown. The output is designed to be read by an AI in a single file load.

## What It Generates

```
.codesight/
  CODESIGHT.md     Combined context map (one file, full project understanding)
  routes.md        Every API route with method, path, params, and what it touches
  schema.md        Every database model with fields, types, keys, and relations
  components.md    Every UI component with its props
  libs.md          Every library export with function signatures
  config.md        Every env var (required vs default), config files, key deps
  middleware.md    Auth, rate limiting, CORS, validation, logging, error handlers
  graph.md         Which files import what and which break the most things if changed
  report.html      Interactive visual dashboard (with --html or --open)
```

## AST Precision

When TypeScript is installed in the project being scanned, codesight uses the actual TypeScript compiler API to parse your code structurally. No regex guessing.

![AST precision: TypeScript available → AST Parse, otherwise Regex fallback](assets/ast-precision.jpg)

| What AST enables | Regex alone |
|---|---|
| Follows `router.use('/prefix', subRouter)` chains | Misses nested routers |
| Combines `@Controller('users')` + `@Get(':id')` into `/users/:id` | May miss prefix |
| Parses `router({ users: userRouter })` tRPC nesting | Line-by-line matching |
| Extracts exact Drizzle field types from `.primaryKey().notNull()` chains | Pattern matching |
| Gets React props from TypeScript interfaces and destructuring | Regex on `{ prop }` |
| Detects middleware in route chains: `app.get('/path', auth, handler)` | Not captured |
| Filters out non-route calls like `c.get('userId')` | May false-positive |

AST detection is reported in the output:

```
Analyzing... done (AST: 60 routes, 18 models, 16 components)
```

No configuration needed. If TypeScript is in your `node_modules`, AST kicks in automatically. Works with npm, yarn, and pnpm (including strict mode). Falls back to regex for non-TypeScript projects or frameworks without AST support.

**AST-supported frameworks:** Express, Hono, Fastify, Koa, Elysia (route chains + middleware), NestJS (decorator combining + guards), tRPC (router nesting + procedure types), Drizzle (field chains + relations), TypeORM (entity decorators), React (props from interfaces + destructuring + forwardRef/memo).

## Routes

Not just paths. Methods, URL parameters, what each route touches (auth, database, cache, payments, AI, email, queues), and where the handler lives. Detects routes across 25+ frameworks automatically.

Example output:

```markdown
- `GET` `/api/users/me` [auth, db, cache]
- `PUT` `/api/users/me` [auth, db]
- `POST` `/api/projects` [auth, db, payment]
- `GET` `/api/projects/:id` params(id) [auth, db]
- `POST` `/webhooks/stripe` [db, payment]
- `GET` `/health`
```

## Schema

Models, fields, types, primary keys, foreign keys, unique constraints, relations. Parsed directly from your ORM definitions via AST. No need to open migration files.

Example output:

```markdown
### user
- id: text (pk)
- name: text (required)
- email: text (unique, required)
- role: text (default, required)
- stripeCustomerId: text (fk)

### project
- id: uuid (default, pk)
- ownerId: text (fk, required)
- name: text (required)
- settings: jsonb (required)
- _relations_: ownerId -> user.id
```

## Dependency Graph

The files imported the most are the ones that break the most things when changed. codesight finds them and tells your AI to be careful.

Example output:

```markdown
## Most Imported Files (change these carefully)
- `src/types/index.ts` — imported by **20** files
- `src/db/index.ts` — imported by **12** files
- `src/lib/auth.ts` — imported by **8** files
- `src/lib/cache.ts` — imported by **6** files
- `src/lib/env.ts` — imported by **5** files
```

## Blast Radius

![Blast radius: changing src/db/index.ts ripples through 10 files across 3 hops](assets/blast-radius.jpg)

BFS through the import graph finds all transitively affected files, routes, models, and middleware.

```bash
npx codesight --blast src/db/index.ts
```

Example output:

```
  Blast Radius: src/db/index.ts
  Depth: 3 hops

  Affected files (10):
    src/api/users.ts
    src/api/projects.ts
    src/api/webhooks.ts
    src/auth/session.ts
    src/jobs/notifications.ts
    src/server.ts
    src/auth/index.ts
    src/jobs/cron.ts
    src/cli.ts
    src/index.ts

  Affected routes (33):
    GET /api/users/me — src/api/users.ts
    POST /api/projects — src/api/projects.ts
    POST /webhooks/stripe — src/api/webhooks.ts
    ...

  Affected models: user, session, account, project,
    subscription, notification, audit_log
```

Your AI can also query blast radius through the MCP server before making changes.

## Environment Audit

Every env var across your codebase, flagged as required or has default, with the exact file where it is referenced.

Example output:

```markdown
- `DATABASE_URL` **required** — .env.example
- `REDIS_URL` (has default) — .env.example
- `STRIPE_SECRET_KEY` **required** — src/lib/payments.ts
- `STRIPE_WEBHOOK_SECRET` **required** — .env.example
- `RESEND_API_KEY` **required** — .env.example
- `JWT_SECRET` **required** — src/lib/auth.ts
```

## Token Benchmark

See exactly where your token savings come from:

```bash
npx codesight --benchmark
```

Example output (92-file monorepo):

```
  Token Savings Breakdown:
  ┌──────────────────────────────────────────────────┐
  │ What codesight found         │ Exploration cost   │
  ├──────────────────────────────┼────────────────────┤
  │  60 routes                   │ ~24,000 tokens     │
  │  18 schema models            │ ~ 5,400 tokens     │
  │  16 components               │ ~ 4,000 tokens     │
  │  36 library files            │ ~ 7,200 tokens     │
  │  22 env vars                 │ ~ 2,200 tokens     │
  │   5 middleware               │ ~ 1,000 tokens     │
  │  20 hot files                │ ~ 3,000 tokens     │
  │  92 files (search overhead)  │ ~ 4,000 tokens     │
  ├──────────────────────────────┼────────────────────┤
  │ codesight output             │ ~ 5,129 tokens     │
  │ Manual exploration (1.3x)    │ ~66,040 tokens     │
  │ SAVED PER CONVERSATION       │ ~60,911 tokens     │
  └──────────────────────────────┴────────────────────┘
```

### How Token Savings Are Calculated

Each detector type maps to a measured token cost that an AI would spend to discover the same information manually:

| What codesight finds | Tokens saved per item | Why |
|---|---|---|
| Each route | ~400 tokens | AI reads the handler file, greps for the path, reads middleware |
| Each schema model | ~300 tokens | AI opens migration/ORM files, parses fields manually |
| Each component | ~250 tokens | AI opens component files, reads prop types |
| Each library export | ~200 tokens | AI greps for exports, reads signatures |
| Each env var | ~100 tokens | AI greps for `process.env`, reads .env files |
| Each file scanned | ~80 tokens | AI runs glob/grep operations to find relevant files |

The 1.3x multiplier accounts for AI revisiting files during multi-turn conversations. These estimates are conservative. A developer manually verified that Claude Code spends 40-70K tokens exploring the same projects that codesight summarizes in 3-5K tokens.

## Supported Stacks

| Category | Supported |
|---|---|
| **Routes** | Hono, Express, Fastify, Next.js (App + Pages), Koa, NestJS, tRPC, Elysia, AdonisJS, SvelteKit, Remix, Nuxt, FastAPI, Flask, Django, Go (net/http, Gin, Fiber, Echo, Chi), Rails, Phoenix, Spring Boot, Actix, Axum, raw http.createServer |
| **Schema** | Drizzle, Prisma, TypeORM, Mongoose, Sequelize, SQLAlchemy, ActiveRecord, Ecto (8 ORMs) |
| **Components** | React, Vue, Svelte (auto-filters shadcn/ui and Radix primitives) |
| **Libraries** | TypeScript, JavaScript, Python, Go, Ruby, Elixir, Java, Kotlin, Rust (exports with function signatures) |
| **Middleware** | Auth, rate limiting, CORS, validation, logging, error handlers |
| **Dependencies** | Import graph with hot file detection (most imported = highest blast radius) |
| **Contracts** | URL params, request types, response types from route handlers |
| **Monorepos** | pnpm, npm, yarn workspaces (cross-workspace detection) |
| **Languages** | TypeScript, JavaScript, Python, Go, Ruby, Elixir, Java, Kotlin, Rust, PHP |

## AI Config Generation

```bash
npx codesight --init
```

Generates ready-to-use instruction files for every major AI coding tool at once:

| File | Tool |
|---|---|
| `CLAUDE.md` | Claude Code |
| `.cursorrules` | Cursor |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `codex.md` | OpenAI Codex CLI |
| `AGENTS.md` | OpenAI Codex agents |

Each file is pre-filled with your project's stack, architecture, high-impact files, and required env vars. Your AI reads it on startup and starts with full context from the first message.

## MCP Server (8 Tools)

```bash
npx codesight --mcp
```

Runs as a Model Context Protocol server. Claude Code and Cursor call it directly to get project context on demand.

```json
{
  "mcpServers": {
    "codesight": {
      "command": "npx",
      "args": ["codesight", "--mcp"]
    }
  }
}
```

![MCP Server: Claude Code/Cursor ↔ codesight MCP Server → 6 specialized tools + session cache](assets/mcp-server.jpg)

| Tool | What it does |
|---|---|
| `codesight_scan` | Full project scan (~3K-5K tokens) |
| `codesight_get_summary` | Compact overview (~500 tokens) |
| `codesight_get_routes` | Routes filtered by prefix, tag, or method |
| `codesight_get_schema` | Schema filtered by model name |
| `codesight_get_blast_radius` | Impact analysis before changing a file |
| `codesight_get_env` | Environment variables (filter: required only) |
| `codesight_get_hot_files` | Most imported files with configurable limit |
| `codesight_refresh` | Force re-scan (results are cached per session) |

Your AI asks for exactly what it needs instead of loading the entire context map. Session caching means the first call scans, subsequent calls return instantly.

## AI Tool Profiles

```bash
npx codesight --profile claude-code
npx codesight --profile cursor
npx codesight --profile codex
npx codesight --profile copilot
npx codesight --profile windsurf
```

Generates an optimized config file for a specific AI tool. Each profile includes your project summary, stack info, high-impact files, required env vars, and tool-specific instructions on how to use codesight outputs. For Claude Code, this includes MCP tool usage instructions. For Cursor, it points to the right codesight files. Each profile writes to the correct file for that tool.

## Visual Report

```bash
npx codesight --open
```

Opens an interactive HTML dashboard in your browser. Routes table with method badges and tags. Schema cards with fields and relations. Dependency hot files with impact bars. Env var audit. Token savings breakdown. Useful for onboarding or just seeing your project from above.

## GitHub Action

Add to your CI pipeline to keep context fresh on every push:

```yaml
name: codesight
on: [push]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g codesight && codesight
      - uses: actions/upload-artifact@v4
        with:
          name: codesight
          path: .codesight/
```

## Watch Mode and Git Hook

**Watch mode** re-scans automatically when your code changes:

```bash
npx codesight --watch
```

Only triggers on source and config files (`.ts`, `.js`, `.py`, `.go`, `.prisma`, `.env`, etc.). Ignores `node_modules`, build output, and non-code files. Shows which files changed before each re-scan. Your config (disabled detectors, plugins) is preserved across re-scans.

**Git hook** regenerates context on every commit:

```bash
npx codesight --hook
```

Context stays fresh without thinking about it.

## All Options

```bash
npx codesight                              # Scan current directory
npx codesight ./my-project                 # Scan specific directory
npx codesight --init                       # Generate AI config files
npx codesight --open                       # Open visual HTML report
npx codesight --html                       # Generate HTML report without opening
npx codesight --mcp                        # Start MCP server (8 tools)
npx codesight --blast src/lib/db.ts        # Show blast radius for a file
npx codesight --profile claude-code        # Optimized config for specific tool
npx codesight --watch                      # Watch mode
npx codesight --hook                       # Install git pre-commit hook
npx codesight --benchmark                  # Detailed token savings breakdown
npx codesight --json                       # Output as JSON
npx codesight -o .ai-context              # Custom output directory
npx codesight -d 5                         # Limit directory depth
```

## How It Compares

| | codesight | File concatenation tools | AST-based tools (e.g. code-review-graph) |
|---|---|---|---|
| **Parsing** | AST (TypeScript compiler) + regex fallback | None | Tree-sitter + SQLite |
| **Token reduction** | 9x-13x measured on real projects | 1x (dumps everything) | 8x reported |
| **Route detection** | 25+ frameworks, auto-detected | None | Limited |
| **Schema parsing** | 8 ORMs with field types and relations | None | Varies |
| **Blast radius** | BFS through import graph | None | Yes |
| **AI tool profiles** | 5 tools (Claude, Cursor, Codex, Copilot, Windsurf) | None | Auto-detect |
| **MCP tools** | 8 specialized tools with session caching | None | 22 tools |
| **Setup** | `npx codesight` (zero deps, zero config) | Copy/paste | `pip install` + optional deps |
| **Dependencies** | Zero (borrows TS from your project) | Varies | Tree-sitter, SQLite, NetworkX, etc. |
| **Language** | TypeScript (zero runtime deps) | Varies | Python |
| **Scan time** | 185-290ms on real projects | Varies | Under 2s reported |

codesight is purpose-built for the problem most developers actually have: giving their AI assistant enough context to be useful without wasting tokens on file exploration. It focuses on structured extraction (routes, schema, components, dependencies) rather than general-purpose code graph analysis.

## Contributing

```bash
git clone https://github.com/Houseofmvps/codesight.git
cd codesight
pnpm install
pnpm dev              # Run locally
pnpm build            # Compile TypeScript
pnpm test             # Run 27 tests
```

PRs welcome. Open an issue first for large changes.

## License

MIT

---

<div align="center">

If codesight saves you tokens, [star it on GitHub](https://github.com/Houseofmvps/codesight) so others find it too.

[![GitHub stars](https://img.shields.io/github/stars/Houseofmvps/codesight?style=for-the-badge&logo=github&color=gold)](https://github.com/Houseofmvps/codesight/stargazers)

</div>

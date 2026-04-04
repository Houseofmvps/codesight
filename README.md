<div align="center">

### Your AI assistant wastes thousands of tokens every conversation just figuring out your project. codesight fixes that in one command.

**Zero dependencies. AST precision. 25+ framework detectors. 8 ORM parsers. 8 MCP tools. Blast radius analysis. One `npx` call.**

[![npm version](https://img.shields.io/npm/v/codesight?style=for-the-badge&logo=npm&color=CB3837)](https://www.npmjs.com/package/codesight)
[![npm downloads](https://img.shields.io/npm/dm/codesight?style=for-the-badge&logo=npm&color=blue&label=Monthly%20Downloads)](https://www.npmjs.com/package/codesight)
[![npm total](https://img.shields.io/npm/dt/codesight?style=for-the-badge&logo=npm&color=cyan&label=Total%20Downloads)](https://www.npmjs.com/package/codesight)
[![GitHub stars](https://img.shields.io/github/stars/Houseofmvps/codesight?style=for-the-badge&logo=github&color=gold)](https://github.com/Houseofmvps/codesight/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge&logo=opensourceinitiative)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Houseofmvps)

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

## What It Does

Every AI coding conversation starts the same way. Your assistant reads files, greps for patterns, opens configs, just to understand the project. That exploration costs tens of thousands of tokens before it writes a single line of code.

codesight scans your codebase once and generates a structured context map. Routes, database schema, components, dependencies, environment variables, middleware, all condensed into ~3,000 to 5,000 tokens of structured markdown. Your AI reads one file and knows the entire project.

**v1.3.0: AST-level precision.** When TypeScript is available in your project, codesight uses the TypeScript compiler API for structural parsing instead of regex. This gives exact route paths, proper controller prefix combining (NestJS), accurate tRPC procedure nesting, precise Drizzle field types, and React prop extraction from type annotations. Zero new dependencies — borrows TypeScript from your project's node_modules. Falls back to regex when TypeScript is not available.

```
Output size:      ~3,200 tokens
Exploration cost: ~52,000 tokens (without codesight)
Saved:            ~48,800 tokens per conversation
```

## How It Works

```mermaid
flowchart LR
    A["Your Codebase"] --> B["codesight"]
    B --> C["AST Parser"]
    B --> D["Regex Fallback"]
    C --> E["Structured Context Map"]
    D --> E
    E --> F["CLAUDE.md"]
    E --> G[".cursorrules"]
    E --> H["codex.md"]
    E --> I["MCP Server"]
    
    style B fill:#f59e0b,stroke:#d97706,color:#000
    style C fill:#10b981,stroke:#059669,color:#000
    style E fill:#3b82f6,stroke:#2563eb,color:#fff
```

```mermaid
flowchart TD
    subgraph Detectors["8 Parallel Detectors"]
        R["Routes<br/>25+ frameworks"]
        S["Schema<br/>8 ORMs"]
        CP["Components<br/>React/Vue/Svelte"]
        G["Dep Graph<br/>Import analysis"]
        M["Middleware<br/>Auth/CORS/etc"]
        CF["Config<br/>Env vars"]
        L["Libraries<br/>Exports + sigs"]
        CT["Contracts<br/>Params + types"]
    end
    
    A["File Scanner"] --> Detectors
    Detectors --> O["~3K-5K tokens<br/>vs ~50K-70K exploration"]
    
    style O fill:#10b981,stroke:#059669,color:#000
```

```mermaid
flowchart LR
    subgraph Without["Without codesight"]
        W1["AI reads files"] --> W2["AI greps patterns"]
        W2 --> W3["AI opens configs"]
        W3 --> W4["AI explores deps"]
        W4 --> W5["50,000+ tokens burned"]
    end
    
    subgraph With["With codesight"]
        C1["AI reads CODESIGHT.md"] --> C2["Full project context"]
        C2 --> C3["~3,000 tokens"]
    end
    
    style W5 fill:#ef4444,stroke:#dc2626,color:#fff
    style C3 fill:#10b981,stroke:#059669,color:#000
```

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

| What AST enables | Regex alone |
|---|---|
| Follows `router.use('/prefix', subRouter)` chains | Misses nested routers |
| Combines `@Controller('users')` + `@Get(':id')` into `/users/:id` | May miss prefix |
| Parses `router({ users: userRouter })` tRPC nesting | Line-by-line matching |
| Extracts exact Drizzle field types from `.primaryKey().notNull()` chains | Pattern matching |
| Gets React props from TypeScript interfaces and destructuring | Regex on `{ prop }` |
| Detects middleware in route chains: `app.get('/path', auth, handler)` | Not captured |

```mermaid
flowchart TD
    F["Source File"] --> Check{"TypeScript<br/>in node_modules?"}
    Check -->|Yes| AST["AST Parse<br/>(TypeScript Compiler API)"]
    Check -->|No| Regex["Regex Parse<br/>(Pattern Matching)"]
    AST --> Result["Routes / Schema / Components"]
    AST -->|"Parse failed"| Regex
    Regex --> Result
    
    style AST fill:#10b981,stroke:#059669,color:#000
    style Regex fill:#f59e0b,stroke:#d97706,color:#000
    style Result fill:#3b82f6,stroke:#2563eb,color:#fff
```

AST detection is indicated in the output:

```
Analyzing... done (AST: 65 routes, 18 models, 16 components)
```

No configuration needed. If TypeScript is in your `node_modules`, AST kicks in automatically. Works with npm, yarn, and pnpm (including strict mode). Falls back to regex for non-TypeScript projects or frameworks without AST support.

## Routes

Not just paths. Methods, URL parameters, what each route touches (auth, database, cache, payments, AI, email, queues), and where the handler lives. Detects routes across 25+ frameworks automatically.

```markdown
- `POST` `/auth/login` [auth, db, email]
- `GET` `/api/projects/:id/analytics` params(id) [auth, db, cache]
- `POST` `/api/billing/checkout` [auth, db, payment]
- `QUERY` `getUsers` [db]             # tRPC procedures
- `MUTATION` `createProject` [db, ai]  # tRPC mutations
```

## Schema

Models, fields, types, primary keys, foreign keys, unique constraints, relations. Parsed directly from your ORM definitions. No need to open migration files.

```markdown
### users
- id: uuid (pk, default)
- email: text (unique, required)
- plan: text (required, default)
- stripeCustomerId: text (fk)

### projects
- id: uuid (pk, default)
- userId: uuid (fk)
- name: text (required)
- domain: text (unique)
- _relations_: userId -> users.id
```

## Dependency Graph

The files imported the most are the ones that break the most things when changed. codesight finds them and tells your AI to be careful.

```markdown
## Most Imported Files (change these carefully)
- `packages/shared/src/index.ts` — imported by **14** files
- `apps/api/src/lib/db.ts` — imported by **9** files
- `apps/api/src/lib/auth.ts` — imported by **7** files
```

## Blast Radius

```mermaid
graph TD
    DB["src/lib/db.ts<br/>(you change this)"] --> U["src/routes/users.ts"]
    DB --> P["src/routes/projects.ts"]
    DB --> B["src/routes/billing.ts"]
    DB --> A["src/routes/auth.ts"]
    U --> MW["src/middleware/auth.ts"]
    P --> MW
    B --> S["src/services/stripe.ts"]
    
    style DB fill:#ef4444,stroke:#dc2626,color:#fff
    style U fill:#f59e0b,stroke:#d97706,color:#000
    style P fill:#f59e0b,stroke:#d97706,color:#000
    style B fill:#f59e0b,stroke:#d97706,color:#000
    style A fill:#f59e0b,stroke:#d97706,color:#000
    style MW fill:#fbbf24,stroke:#f59e0b,color:#000
    style S fill:#fbbf24,stroke:#f59e0b,color:#000
```

See exactly what breaks if you change a file. BFS through the import graph finds all transitively affected files, routes, models, and middleware.

```bash
npx codesight --blast src/lib/db.ts
```

```
  Blast Radius: src/lib/db.ts
  Depth: 3 hops

  Affected files (10):
    src/routes/users.ts
    src/routes/projects.ts
    src/routes/billing.ts
    ...

  Affected routes (33):
    POST /auth/login — src/routes/auth.ts
    GET /api/users — src/routes/users.ts
    ...

  Affected models: users, projects, subscriptions
  Affected middleware: authMiddleware
```

Your AI can also query blast radius through the MCP server before making changes.

## Environment Audit

Every env var across your codebase, flagged as required or has default, with the exact file where it is referenced.

```markdown
- `DATABASE_URL` **required** — apps/api/src/lib/db.ts
- `JWT_SECRET` **required** — apps/api/src/lib/auth.ts
- `PORT` (has default) — apps/api/src/index.ts
```

## Token Benchmark

See exactly where your token savings come from:

```bash
npx codesight --benchmark
```

```
  Token Savings Breakdown:
  ┌──────────────────────────────────────────────────┐
  │ What codesight found         │ Exploration cost   │
  ├──────────────────────────────┼────────────────────┤
  │  65 routes                   │ ~26,000 tokens     │
  │  18 schema models            │ ~ 5,400 tokens     │
  │  16 components               │ ~ 4,000 tokens     │
  │  36 library files            │ ~ 7,200 tokens     │
  │  22 env vars                 │ ~ 2,200 tokens     │
  │  92 files (search overhead)  │ ~ 4,000 tokens     │
  ├──────────────────────────────┼────────────────────┤
  │ codesight output             │ ~ 4,041 tokens     │
  │ SAVED PER CONVERSATION       │ ~64,599 tokens     │
  └──────────────────────────────┴────────────────────┘
```

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

```mermaid
flowchart LR
    AI["Claude Code<br/>or Cursor"] <-->|"JSON-RPC 2.0<br/>over stdio"| MCP["codesight<br/>MCP Server"]
    MCP --> Cache["Session Cache<br/>(scan once)"]
    MCP --> T1["get_summary"]
    MCP --> T2["get_routes"]
    MCP --> T3["get_schema"]
    MCP --> T4["get_blast_radius"]
    MCP --> T5["get_env"]
    MCP --> T6["get_hot_files"]
    
    style MCP fill:#f59e0b,stroke:#d97706,color:#000
    style Cache fill:#10b981,stroke:#059669,color:#000
```

Exposes 8 specialized tools, each returning only what your AI needs:

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

**Watch mode** re-scans when files change:

```bash
npx codesight --watch
```

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

Most AI context tools dump your entire codebase into one file. codesight takes a different approach: it **parses** your code to extract structured information.

| | codesight | File concatenation tools | AST-based tools |
|---|---|---|---|
| **Parsing** | AST when available, regex fallback | None | Tree-sitter / custom |
| **Output** | Structured routes, schema, components, deps | Raw file contents | Call graphs, class diagrams |
| **Token cost** | ~3,000-5,000 tokens | 50,000-500,000+ tokens | Varies |
| **Route detection** | 25+ frameworks auto-detected | None | Limited |
| **Schema parsing** | 8 ORMs with relations | None | Varies |
| **Blast radius** | BFS through import graph | None | Some |
| **AI tool profiles** | 5 tools (Claude, Cursor, Codex, Copilot, Windsurf) | None | None |
| **MCP server** | 8 specialized tools with session caching | None | Some |
| **Setup** | `npx codesight` (zero deps, zero config) | Copy/paste | Install compilers, runtimes |
| **Dependencies** | Zero (borrows TS from your project) | Varies | Tree-sitter, SQLite, etc. |

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
[![Sponsor](https://img.shields.io/badge/Sponsor-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Houseofmvps)

</div>

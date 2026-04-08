# codesight — Overview

> **Navigation aid.** This article shows WHERE things live (routes, models, files). Read actual source files before implementing new features or making changes.

**codesight** is a typescript project built with raw-http.

## Scale

8 API routes · 5 middleware layers · 6 environment variables

## Subsystems

- **[Detectors.test](./detectors.test.md)** — 1 routes — touches: auth, db
- **[Graphql](./graphql.md)** — 4 routes
- **[Path](./path.md)** — 1 routes — touches: auth, db, cache, queue, email
- **[Infra](./infra.md)** — 1 routes — touches: auth, db
- **[Api](./api.md)** — 1 routes — touches: auth, db, cache, queue, email

## High-Impact Files

Changes to these files have the widest blast radius across the codebase:

- `src/types.ts` — imported by **35** files
- `src/scanner.ts` — imported by **14** files
- `src/ast/loader.ts` — imported by **6** files
- `src/ast/extract-dart.ts` — imported by **3** files
- `src/ast/extract-swift.ts` — imported by **3** files
- `src/ast/extract-csharp.ts` — imported by **3** files

## Required Environment Variables

- `DATABASE_URL` — `tests/fixtures/config-app/.env.example`
- `JWT_SECRET` — `tests/fixtures/config-app/.env.example`
- `VAR` — `src/detectors/config.ts`
- `VAR_NAME` — `src/detectors/config.ts`
- `VITE_VAR_NAME` — `src/detectors/config.ts`

---
_Back to [index.md](./index.md) · Generated 2026-04-08_
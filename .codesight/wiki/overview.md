# codesight — Overview

> **Navigation aid.** This article shows WHERE things live (routes, models, files). Read actual source files before implementing new features or making changes.

**codesight** is a typescript project built with raw-http.

## Scale

8 API routes · 65 library files · 5 middleware layers · 10 environment variables

## Subsystems

- **[Detectors.test](./detectors.test.md)** — 1 routes — touches: auth, db, cache, queue, payment
- **[Graphql](./graphql.md)** — 4 routes
- **[Path](./path.md)** — 1 routes — touches: auth, db, cache, queue, email
- **[Infra](./infra.md)** — 1 routes — touches: auth, db, cache, queue, payment
- **[Api](./api.md)** — 1 routes — touches: auth, db, cache, queue, email

**Libraries:** 65 files — see [libraries.md](./libraries.md)

## High-Impact Files

Changes to these files have the widest blast radius across the codebase:

- `src/types.ts` — imported by **50** files
- `src/scanner.ts` — imported by **16** files
- `src/ast/loader.ts` — imported by **6** files
- `src/plugins/terraform/types.ts` — imported by **6** files
- `src/ast/extract-brightscript.ts` — imported by **5** files
- `src/plugins/cicd/types.ts` — imported by **5** files

## Required Environment Variables

- `CODESIGHT_NATIVE_AST` — `src/index.ts`
- `CODESIGHT_PLUGIN_DIR` — `src/index.ts`
- `CODESIGHT_REFERENCE_PLUGIN_DIR` — `tests/reference-plugin.test.ts`
- `DATABASE_URL` — `tests/fixtures/config-app/.env.example`
- `JWT_SECRET` — `tests/fixtures/config-app/.env.example`
- `VAR` — `src/detectors/config.ts`
- `VAR_NAME` — `src/detectors/config.ts`
- `VITE_VAR_NAME` — `src/detectors/config.ts`
- `XDG_DATA_HOME` — `src/ast/native-loader.ts`

---
_Back to [index.md](./index.md) · Generated 2026-06-27_
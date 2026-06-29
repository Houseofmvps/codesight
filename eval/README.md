# codesight Evaluation Suite

Reproducible accuracy benchmarks for codesight detectors.

## How It Works

Each fixture in `fixtures/` contains:
- `repo.json` — describes the repo structure (files with inline content)
- `ground-truth.json` — expected detection results (routes, models, env vars, blast radius)

Running `npx codesight --eval` will:
1. Create temporary directories from each fixture
2. Run codesight detectors on them
3. Compare results against ground truth
4. Print precision, recall, F1 score, and runtime per fixture

## Fixtures

| Fixture | Stack | What it tests |
|---|---|---|
| `nextjs-drizzle` | Next.js App Router + Drizzle ORM | Routes, schema, components, env vars |
| `express-prisma` | Express + Prisma | Route detection, schema parsing, middleware |
| `fastapi-sqlalchemy` | FastAPI + SQLAlchemy | Python routes, Python ORM, config |
| `gin-gorm` | Go + Gin + GORM | Go routes (Gin), GORM schema |
| `hono-monorepo` | Hono + Drizzle (pnpm monorepo) | Monorepo detection, workspace routes, schema |

## Adding a Fixture

1. Create a folder in `fixtures/` with `repo.json` and `ground-truth.json`
2. Follow the JSON schema used by existing fixtures
3. Run `npx codesight --eval` to verify

## Metrics

- **Precision**: of all items codesight detected, how many are correct?
- **Recall**: of all items that exist, how many did codesight find?
- **F1**: harmonic mean of precision and recall

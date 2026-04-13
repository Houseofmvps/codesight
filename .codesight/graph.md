# Dependency Graph

## Most Imported Files (change these carefully)

- `src/types.ts` — imported by **41** files
- `src/scanner.ts` — imported by **16** files
- `src/ast/loader.ts` — imported by **6** files
- `src/detectors/routes.ts` — imported by **3** files
- `src/detectors/schema.ts` — imported by **3** files
- `src/detectors/components.ts` — imported by **3** files
- `src/detectors/config.ts` — imported by **3** files
- `src/detectors/middleware.ts` — imported by **3** files
- `src/formatter.ts` — imported by **3** files
- `src/ast/extract-dart.ts` — imported by **3** files
- `src/ast/extract-swift.ts` — imported by **3** files
- `src/ast/extract-android.ts` — imported by **3** files
- `src/ast/extract-csharp.ts` — imported by **3** files
- `src/ast/extract-php.ts` — imported by **3** files
- `src/generators/ai-config.ts` — imported by **3** files
- `src/core.ts` — imported by **3** files
- `src/monorepo/discover.ts` — imported by **3** files
- `tests/fixtures/graph-app/src/db.ts` — imported by **3** files
- `src/detectors/libs.ts` — imported by **2** files
- `src/detectors/graph.ts` — imported by **2** files

## Import Map (who imports what)

- `src/types.ts` ← `src/ast/extract-android.ts`, `src/ast/extract-components.ts`, `src/ast/extract-csharp.ts`, `src/ast/extract-dart.ts`, `src/ast/extract-go.ts` +36 more
- `src/scanner.ts` ← `src/core.ts`, `src/detectors/components.ts`, `src/detectors/config.ts`, `src/detectors/contracts.ts`, `src/detectors/coverage.ts` +11 more
- `src/ast/loader.ts` ← `src/ast/extract-components.ts`, `src/ast/extract-routes.ts`, `src/ast/extract-schema.ts`, `src/detectors/components.ts`, `src/detectors/routes.ts` +1 more
- `src/detectors/routes.ts` ← `src/core.ts`, `src/eval.ts`, `src/mcp-server.ts`
- `src/detectors/schema.ts` ← `src/core.ts`, `src/eval.ts`, `src/mcp-server.ts`
- `src/detectors/components.ts` ← `src/core.ts`, `src/eval.ts`, `src/mcp-server.ts`
- `src/detectors/config.ts` ← `src/core.ts`, `src/eval.ts`, `src/mcp-server.ts`
- `src/detectors/middleware.ts` ← `src/core.ts`, `src/eval.ts`, `src/mcp-server.ts`
- `src/formatter.ts` ← `src/core.ts`, `src/index.ts`, `src/mcp-server.ts`
- `src/ast/extract-dart.ts` ← `src/detectors/components.ts`, `src/detectors/libs.ts`, `src/detectors/routes.ts`

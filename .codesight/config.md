# Config

## Environment Variables

- `CODESIGHT_NATIVE_AST` **required** — src/index.ts
- `CODESIGHT_PLUGIN_DIR` **required** — src/index.ts
- `CODESIGHT_REFERENCE_PLUGIN_DIR` **required** — tests/reference-plugin.test.ts
- `DATABASE_URL` **required** — tests/fixtures/config-app/.env.example
- `JWT_SECRET` **required** — tests/fixtures/config-app/.env.example
- `PORT` (has default) — tests/fixtures/config-app/.env.example
- `VAR` **required** — src/detectors/config.ts
- `VAR_NAME` **required** — src/detectors/config.ts
- `VITE_VAR_NAME` **required** — src/detectors/config.ts
- `XDG_DATA_HOME` **required** — src/ast/native-loader.ts

## Config Files

- `tests/fixtures/config-app/.env.example`
- `tsconfig.json`

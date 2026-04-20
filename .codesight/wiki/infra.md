# Infra

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Infra subsystem handles **1 routes** and touches: auth, db, cache, queue, payment.

## Routes

- `ALL` `/health` [auth, db, cache, queue, payment] `[inferred]`
  `tests/detectors.test.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `tests/detectors.test.ts`

---
_Back to [overview.md](./overview.md)_
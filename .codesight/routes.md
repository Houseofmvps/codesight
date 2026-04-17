# Routes

- `ALL` `/path` [auth, db, cache, queue, email, payment, upload, ai] `[inferred]`
- `ALL` `/api` [auth, db, cache, queue, email, payment, upload, ai] `[inferred]`
- `ALL` `/health` [auth, db, cache, queue, payment] `[inferred]` ✓
- `GET` `/api/users` [auth, db, cache, queue, payment] `[inferred]` ✓

## GraphQL

### QUERY
- `name`

## WebSocket Events

- `WS` `eventName` — `src/detectors/graphql.ts`
- `WS-ROOM` `room` — `src/detectors/graphql.ts`
- `WS` `room:*` — `src/detectors/graphql.ts`

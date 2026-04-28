import { Hono } from "hono";
const app = new Hono();
app.get("/api/users", (c) => c.json([]));
app.post("/api/users", (c) => c.json({}));
app.get("/api/users/:id", (c) => c.json({}));
export default app;
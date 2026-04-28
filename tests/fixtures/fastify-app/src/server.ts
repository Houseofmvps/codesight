import fastify from "fastify";
const app = fastify();
app.get("/health", async () => ({ status: "ok" }));
app.post("/items", async (req) => ({ created: true }));
export default app;
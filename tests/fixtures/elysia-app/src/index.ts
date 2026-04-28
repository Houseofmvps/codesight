import { Elysia } from "elysia";
const app = new Elysia()
  .get("/api/health", () => "ok")
  .post("/api/items", () => ({ created: true }));
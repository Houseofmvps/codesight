import { createServer } from "http";
const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://localhost").pathname;
  if (url === "/health") { res.end("ok"); return; }
  if (url === "/api/users" && req.method === "GET") { res.end("[]"); return; }
  if (url === "/api/users" && req.method === "POST") { res.end("{}"); return; }
});
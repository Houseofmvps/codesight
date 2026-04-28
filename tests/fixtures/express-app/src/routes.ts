import { Router } from "express";
const router = Router();
router.get("/users", (req, res) => res.json([]));
router.post("/users", (req, res) => res.json({}));
router.delete("/users/:id", (req, res) => res.json({}));
export default router;
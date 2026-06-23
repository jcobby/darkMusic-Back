import { Router } from "express";
import { login, me } from "../controllers/auth.controller";
import { requireAdmin } from "../middleware/auth";
import { loginLimiter } from "../middleware/rateLimit";

const router = Router();

router.post("/login", loginLimiter, login);
router.get("/me", requireAdmin, me);

export default router;

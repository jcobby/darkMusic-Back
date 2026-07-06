import { Router } from "express";
import {
  register,
  login,
  me,
  checkIn,
  changePassword,
  forgotPassword,
  resetPassword,
} from "../controllers/fanAuth.controller";
import {
  listFavorites,
  addFavorite,
  removeFavorite,
} from "../controllers/favorites.controller";
import {
  initializeStreamPass,
  verifyStreamPass,
} from "../controllers/streamPass.controller";
import { requireFan } from "../middleware/auth";
import { loginLimiter } from "../middleware/rateLimit";

const router = Router();

router.post("/register", loginLimiter, register);
router.post("/login", loginLimiter, login);
router.get("/me", requireFan, me);
router.post("/checkin", requireFan, checkIn);

// Password management
router.post("/password", requireFan, changePassword);
router.post("/forgot", loginLimiter, forgotPassword);
router.post("/reset", loginLimiter, resetPassword);

router.get("/favorites", requireFan, listFavorites);
router.post("/favorites", requireFan, addFavorite);
router.delete("/favorites/:kind/:refId", requireFan, removeFavorite);

// Streaming pass
router.post("/stream-pass/initialize", requireFan, initializeStreamPass);
router.get("/stream-pass/verify", requireFan, verifyStreamPass);

export default router;

import { Router } from "express";
import {
  register,
  login,
  me,
  checkIn,
  changePassword,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
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
import { submitVideo, submitModel, mySubmissions } from "../controllers/submissions.controller";
import { requireFan } from "../middleware/auth";
import { loginLimiter, uploadLimiter } from "../middleware/rateLimit";
import { upload } from "../services/upload";

const router = Router();

const videoSubmitUpload = upload.fields([
  { name: "videoFile", maxCount: 1 },
  { name: "poster", maxCount: 1 },
]);
const modelSubmitUpload = upload.fields([{ name: "photos", maxCount: 8 }]);

router.post("/register", loginLimiter, register);
router.post("/login", loginLimiter, login);
router.get("/me", requireFan, me);
router.post("/checkin", requireFan, checkIn);

// Email verification
router.post("/verify", loginLimiter, verifyEmail);
router.post("/resend-verification", requireFan, resendVerification);

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

// Content submissions (go into the admin review queue)
router.post("/submissions/video", requireFan, uploadLimiter, videoSubmitUpload, submitVideo);
router.post("/submissions/model", requireFan, uploadLimiter, modelSubmitUpload, submitModel);
router.get("/submissions/mine", requireFan, mySubmissions);

export default router;

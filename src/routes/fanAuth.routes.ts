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
import {
  listMyBookings,
  payBooking,
  verifyBookingPayment,
  cancelMyBooking,
  reviewBooking,
  getMyModel,
  updateMyModel,
  respondAsModel,
} from "../controllers/bookings.controller";
import { requireFan } from "../middleware/auth";
import { loginLimiter, uploadLimiter, checkoutLimiter } from "../middleware/rateLimit";
import { upload } from "../services/upload";
import { MODELS_MARKET } from "../config/modelsMarket";

const router = Router();

const videoSubmitUpload = upload.fields([
  { name: "videoFile", maxCount: 1 },
  { name: "poster", maxCount: 1 },
]);
const modelSubmitUpload = upload.fields([
  { name: "photos", maxCount: MODELS_MARKET.maxPhotos },
  { name: "video", maxCount: 1 },
]);

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

// Model bookings — the customer's side
router.get("/bookings", requireFan, listMyBookings);
router.get("/bookings/verify", requireFan, verifyBookingPayment);
router.post("/bookings/:id/pay", requireFan, checkoutLimiter, payBooking);
router.post("/bookings/:id/cancel", requireFan, cancelMyBooking);
router.post("/bookings/:id/review", requireFan, reviewBooking);

// Model dashboard — the model's side
router.get("/model", requireFan, getMyModel);
router.patch("/model", requireFan, updateMyModel);
router.patch("/model/bookings/:id", requireFan, respondAsModel);

export default router;

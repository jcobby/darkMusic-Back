import { Router } from "express";
import { requireAdmin } from "../middleware/auth";
import { upload } from "../services/upload";
import {
  adminListReleases,
  createRelease,
  updateRelease,
  deleteRelease,
  adminListBeats,
  createBeat,
  updateBeat,
  deleteBeat,
  adminListMerch,
  createMerch,
  updateMerch,
  deleteMerch,
  adminListWorn,
  createWorn,
  adminListVideos,
  createVideo,
  updateVideo,
  deleteVideo,
  adminListModels,
  createModel,
  updateModel,
  deleteModel,
  adminListBookings,
  updateBooking,
  adminListSubmissions,
  reviewVideo,
  reviewModel,
  adminListInquiries,
  updateInquiry,
  adminListOrders,
  adminListDonations,
  adminListGallery,
  createGalleryPhotos,
  updateGalleryPhoto,
  deleteGalleryPhoto,
} from "../controllers/admin.controller";
import { getStats } from "../controllers/stats.controller";
import { adminLeaderboard, setDisqualified } from "../controllers/games.controller";
import {
  listDeposits,
  startDeposit,
  verifyDeposit,
  adminWithdrawals,
  sendWithdrawal,
  finalizeWithdrawal,
  markWithdrawalPaid,
  rejectWithdrawal,
} from "../controllers/prize.controller";
import { adminListLive, createLive, updateLive, deleteLive } from "../controllers/live.controller";
import { deleteWallPost } from "../controllers/wall.controller";
import { adminListCustomers, adminCustomerDetail } from "../controllers/customers.controller";
import { adminListFeedback, updateFeedback } from "../controllers/feedback.controller";
import {
  adminTrivia,
  adminTriviaSettings,
  adminCreateQuestion,
  adminUpdateQuestion,
  adminDeleteQuestion,
  adminUpdateAttempt,
} from "../controllers/trivia.controller";

const router = Router();

// Every admin route requires a valid admin JWT.
router.use(requireAdmin);

// Fan Wall moderation
router.delete("/wall/:id", deleteWallPost);

// Site stats: all-time total + daily breakdown
router.get("/visits", getStats);

// Customers (every account and what they've done) and visitors' feedback
router.get("/customers", adminListCustomers);
router.get("/customers/:id", adminCustomerDetail);
router.get("/feedback", adminListFeedback);
router.patch("/feedback/:id", updateFeedback);

// Lenko Trivia: settings, the question bank, results and prize payouts
router.get("/trivia", adminTrivia);
router.put("/trivia/settings", adminTriviaSettings);
router.post("/trivia/questions", adminCreateQuestion);
router.put("/trivia/questions/:id", adminUpdateQuestion);
router.delete("/trivia/questions/:id", adminDeleteQuestion);
router.patch("/trivia/attempts/:id", adminUpdateAttempt);

const releaseUpload = upload.fields([
  { name: "cover", maxCount: 1 },
  { name: "audio", maxCount: 1 },
]);
const beatUpload = upload.fields([
  { name: "cover", maxCount: 1 },
  { name: "mp3Free", maxCount: 1 },
  { name: "wav", maxCount: 1 },
]);
const merchUpload = upload.fields([{ name: "images", maxCount: 10 }]);
const videoUpload = upload.fields([
  { name: "poster", maxCount: 1 },
  { name: "videoFile", maxCount: 1 },
]);
const modelUpload = upload.fields([
  { name: "photos", maxCount: 8 },
  { name: "video", maxCount: 1 },
]);

// Releases
router.get("/releases", adminListReleases);
router.post("/releases", releaseUpload, createRelease);
router.put("/releases/:id", releaseUpload, updateRelease);
router.delete("/releases/:id", deleteRelease);

// Beats
router.get("/beats", adminListBeats);
router.post("/beats", beatUpload, createBeat);
router.put("/beats/:id", beatUpload, updateBeat);
router.delete("/beats/:id", deleteBeat);

// Merch
router.get("/merch", adminListMerch);
router.post("/merch", merchUpload, createMerch);
router.put("/merch/:id", merchUpload, updateMerch);
router.delete("/merch/:id", deleteMerch);

// Worn on Set — used pieces from the shoots, always sold by auction
router.get("/worn", adminListWorn);
router.post("/worn", merchUpload, createWorn);
router.put("/worn/:id", merchUpload, updateMerch);
router.delete("/worn/:id", deleteMerch);

// Videos (content-creation)
router.get("/videos", adminListVideos);
router.post("/videos", videoUpload, createVideo);
router.put("/videos/:id", videoUpload, updateVideo);
router.delete("/videos/:id", deleteVideo);

// Monthly game prize
router.get("/games/:game/leaderboard", adminLeaderboard);
router.post("/games/:game/disqualify", setDisqualified);
// Prize pool deposits (paid in through Paystack) and winners' withdrawals (paid out by Paystack)
router.get("/games/:game/deposits", listDeposits);
router.post("/games/:game/deposits", startDeposit);
router.get("/games/:game/deposits/verify", verifyDeposit);
router.get("/wallet/withdrawals", adminWithdrawals);
router.post("/wallet/withdrawals/:id/send", sendWithdrawal);
router.post("/wallet/withdrawals/:id/otp", finalizeWithdrawal);
router.post("/wallet/withdrawals/:id/mark-paid", markWithdrawalPaid);
router.post("/wallet/withdrawals/:id/reject", rejectWithdrawal);

// Pay-per-view live shows
const liveUpload = upload.fields([{ name: "poster", maxCount: 1 }]);
router.get("/live", adminListLive);
router.post("/live", liveUpload, createLive);
router.put("/live/:id", liveUpload, updateLive);
router.delete("/live/:id", deleteLive);

// Behind-the-scenes gallery (several photos per upload)
const galleryUpload = upload.fields([{ name: "images", maxCount: 20 }]);
router.get("/gallery", adminListGallery);
router.post("/gallery", galleryUpload, createGalleryPhotos);
router.put("/gallery/:id", galleryUpload, updateGalleryPhoto);
router.delete("/gallery/:id", deleteGalleryPhoto);

// Models (booking) + booking requests
router.get("/models", adminListModels);
router.post("/models", modelUpload, createModel);
router.put("/models/:id", modelUpload, updateModel);
router.delete("/models/:id", deleteModel);
router.get("/bookings", adminListBookings);
router.patch("/bookings/:id", updateBooking);

// Submission review queue (fan/creator/model uploads awaiting approval)
router.get("/submissions", adminListSubmissions);
router.patch("/submissions/video/:id", reviewVideo);
router.patch("/submissions/model/:id", reviewModel);

// Inquiries, orders & donations
router.get("/inquiries", adminListInquiries);
router.patch("/inquiries/:id", updateInquiry);
router.get("/orders", adminListOrders);
router.get("/donations", adminListDonations);

export default router;

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
  adminListInquiries,
  updateInquiry,
  adminListOrders,
  adminListDonations,
} from "../controllers/admin.controller";
import { getStats } from "../controllers/stats.controller";

const router = Router();

// Every admin route requires a valid admin JWT.
router.use(requireAdmin);

// Site stats: all-time total + daily breakdown
router.get("/visits", getStats);

const releaseUpload = upload.fields([
  { name: "cover", maxCount: 1 },
  { name: "audio", maxCount: 1 },
]);
const beatUpload = upload.fields([
  { name: "cover", maxCount: 1 },
  { name: "mp3Free", maxCount: 1 },
  { name: "wav", maxCount: 1 },
]);
const merchUpload = upload.fields([{ name: "images", maxCount: 6 }]);

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

// Inquiries, orders & donations
router.get("/inquiries", adminListInquiries);
router.patch("/inquiries/:id", updateInquiry);
router.get("/orders", adminListOrders);
router.get("/donations", adminListDonations);

export default router;

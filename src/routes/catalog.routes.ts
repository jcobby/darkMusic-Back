import { Router } from "express";
import {
  listReleases,
  getRelease,
  previewRelease,
  getWelcomeTrack,
  listBeats,
  getBeat,
  downloadFreeBeat,
  listMerch,
  getMerch,
} from "../controllers/catalog.controller";
import { recordVisit } from "../controllers/stats.controller";

const router = Router();

router.get("/welcome", getWelcomeTrack);
router.post("/visits", recordVisit); // public: record a visit (read is admin-only)
router.get("/releases", listReleases);
router.get("/releases/:slug", getRelease);
router.get("/releases/:slug/preview", previewRelease);

router.get("/beats", listBeats);
router.get("/beats/:slug", getBeat);
router.get("/beats/:slug/free", downloadFreeBeat);

router.get("/merch", listMerch);
router.get("/merch/:slug", getMerch);

export default router;

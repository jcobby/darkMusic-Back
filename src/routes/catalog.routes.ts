import { Router } from "express";
import {
  listReleases,
  listTrending,
  getRelease,
  previewRelease,
  getWelcomeTrack,
  listBeats,
  getBeat,
  downloadFreeBeat,
  listMerch,
  getMerch,
  listGallery,
} from "../controllers/catalog.controller";
import {
  recordVisit,
  getVisitTotal,
  recordPlay,
  getPublicStats,
} from "../controllers/stats.controller";
import { newsFeed } from "../controllers/news.controller";
import { getAuction, placeBid, payAuction } from "../controllers/auction.controller";
import { optionalFan, requireFan } from "../middleware/auth";
import { bidLimiter, checkoutLimiter } from "../middleware/rateLimit";

const router = Router();

router.get("/welcome", getWelcomeTrack);
router.post("/visits", recordVisit); // public: record a visit
router.get("/visits", getVisitTotal); // public: today's visit count (footer)
router.post("/plays", recordPlay); // public: count an on-site audio play
router.get("/stats", getPublicStats); // public: live counters band
router.get("/news", newsFeed); // public: Ghana music/hip-hop/new-release headlines
router.get("/trending", listTrending); // public: releases ranked by plays
router.get("/releases", listReleases);
router.get("/releases/:slug", getRelease);
router.get("/releases/:slug/preview", previewRelease);

router.get("/beats", listBeats);
router.get("/beats/:slug", getBeat);
router.get("/beats/:slug/free", downloadFreeBeat);

router.get("/merch", listMerch);
router.get("/merch/:slug", getMerch);

router.get("/gallery", listGallery); // behind-the-scenes photos

// Merch auctions
router.get("/merch/:slug/auction", optionalFan, getAuction);
router.post("/merch/:slug/bids", requireFan, bidLimiter, placeBid);
router.post("/merch/:slug/auction/pay", requireFan, checkoutLimiter, payAuction);

export default router;

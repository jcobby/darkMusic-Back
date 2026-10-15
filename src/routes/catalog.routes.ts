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
  listWorn,
  listGallery,
} from "../controllers/catalog.controller";
import {
  recordVisit,
  getVisitTotal,
  recordPlay,
  getPublicStats,
  getSupporters,
} from "../controllers/stats.controller";
import {
  startRun,
  submitScore,
  leaderboard,
  myPrizes,
  withdrawPrize,
  gameMusic,
  unlockUnreleased,
  streamUnreleased,
} from "../controllers/games.controller";
import {
  listLive,
  getLive,
  buyTicket,
  verifyTicket,
  watchLive,
} from "../controllers/live.controller";
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
router.get("/worn", listWorn); // Worn on Set auction pieces
router.get("/merch/:slug", getMerch);

router.get("/gallery", listGallery); // behind-the-scenes photos
router.get("/supporters", getSupporters); // public: fans who supported this month

// Game prize leaderboard (Beat Breaker)
router.post("/games/:game/start", optionalFan, startRun); // anyone; only signed-in runs reach the prize board
router.get("/games/:game/music", gameMusic);
router.post("/games/:game/unreleased", optionalFan, bidLimiter, unlockUnreleased);
router.get("/games/:game/unreleased/stream", streamUnreleased);
router.post("/games/:game/scores", requireFan, bidLimiter, submitScore);
router.get("/games/:game/leaderboard", optionalFan, leaderboard);
router.get("/games/:game/prizes/mine", requireFan, myPrizes);
router.post("/games/:game/prizes/:month/withdraw", requireFan, checkoutLimiter, withdrawPrize);

// Pay-per-view live shows
router.get("/live", optionalFan, listLive);
router.get("/live/:slug", optionalFan, getLive);
router.post("/live/:slug/ticket", requireFan, checkoutLimiter, buyTicket);
router.get("/live/:slug/ticket/verify", requireFan, verifyTicket);
router.get("/live/:slug/watch", requireFan, watchLive);

// Merch auctions
router.get("/merch/:slug/auction", optionalFan, getAuction);
router.post("/merch/:slug/bids", requireFan, bidLimiter, placeBid);
router.post("/merch/:slug/auction/pay", requireFan, checkoutLimiter, payAuction);

export default router;

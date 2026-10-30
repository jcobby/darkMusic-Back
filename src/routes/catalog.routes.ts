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
  gameMusic,
  gameRecord,
  songClips,
  unlockUnreleased,
  streamUnreleased,
} from "../controllers/games.controller";
import { prizePool, myWallet, requestWithdrawal, cancelWithdrawal } from "../controllers/prize.controller";
import { listEvents, getEvent } from "../controllers/events.controller";
import { beatOfTheDay } from "../controllers/beatOfDay.controller";
import {
  poolMe,
  poolJoinQueue,
  poolCheckQueue,
  poolLeaveQueue,
  poolChallenge,
  poolMatch,
  poolAccept,
  poolShot,
  poolConcede,
  poolLadder,
  poolNight,
} from "../controllers/pool.controller";
import { listSquads, squadInvite, createSquad, joinSquad, leaveSquad, removeFromSquad } from "../controllers/squads.controller";
import {
  listLive,
  getLive,
  buyTicket,
  verifyTicket,
  watchLive,
} from "../controllers/live.controller";
import { newsFeed } from "../controllers/news.controller";
import { getAuction, placeBid, payAuction } from "../controllers/auction.controller";
import { submitFeedback } from "../controllers/feedback.controller";
import { triviaSession, triviaState, triviaStart, triviaAnswer, triviaLeaderboard } from "../controllers/trivia.controller";
import { membershipPlans, supporterWall } from "../controllers/membership.controller";
import { promoInfo, promoClick } from "../controllers/promoter.controller";
import { optionalFan, requireFan } from "../middleware/auth";
import {
  bidLimiter,
  checkoutLimiter,
  inquiryLimiter,
  poolPollLimiter,
  promoClickLimiter,
  scoreLimiter,
  triviaLimiter,
  triviaPollLimiter,
} from "../middleware/rateLimit";

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
// The Feedback button on every page (signed-in fans are linked to their account)
router.post("/feedback", optionalFan, inquiryLimiter, submitFeedback);

// Lenko Trivia — a monthly session for members (start my question → answer → result)
router.get("/trivia/session", triviaSession);
router.get("/trivia/leaderboard", triviaLeaderboard);
router.get("/trivia/state", requireFan, triviaPollLimiter, triviaState);
router.post("/trivia/start", requireFan, triviaLimiter, triviaStart);
router.post("/trivia/answer", requireFan, triviaLimiter, triviaAnswer);

router.post("/games/:game/start", optionalFan, startRun); // anyone; only signed-in runs reach the prize board
router.get("/games/:game/music", gameMusic);
router.get("/game-songs", songClips); // Lenko songs as short clips, for DMY Pool's soundtrack
router.post("/games/:game/unreleased", optionalFan, bidLimiter, unlockUnreleased);
router.get("/games/:game/unreleased/stream", streamUnreleased);
router.post("/games/:game/scores", requireFan, scoreLimiter, submitScore); // saves a run's progress as it's played
router.get("/games/:game/leaderboard", optionalFan, leaderboard);
router.get("/games/:game/record", gameRecord); // this month's best single game — the Brick Challenge banner
router.get("/games/:game/prize", prizePool); // public: the pool (every deposit), past winners, total paid out

// DMY Pool: ranked 1v1 8-ball (matchmaking), friend challenges, the ladder
router.get("/pool/me", requireFan, poolPollLimiter, poolMe);
router.post("/pool/queue", requireFan, poolPollLimiter, poolJoinQueue);
router.get("/pool/queue", requireFan, poolPollLimiter, poolCheckQueue);
router.delete("/pool/queue", requireFan, poolLeaveQueue);
router.post("/pool/challenges", requireFan, bidLimiter, poolChallenge);
router.get("/pool/matches/:code", optionalFan, poolPollLimiter, poolMatch);
router.post("/pool/matches/:code/accept", requireFan, bidLimiter, poolAccept);
router.post("/pool/matches/:code/shot", requireFan, poolPollLimiter, poolShot);
router.post("/pool/matches/:code/concede", requireFan, poolConcede);
router.get("/pool/ladder", optionalFan, poolLadder);
router.get("/pool/night", poolNight); // DMY Pool Night: Thursdays from 7pm

// DMY membership plans, and this month's Supporter Wall
router.get("/membership", membershipPlans);
router.get("/supporters/wall", supporterWall);

// Lenko Army promoter links (darkmusicyard.com/r/<code>): where they go, and counting a click
router.get("/promo", promoInfo);
router.post("/promo/click", promoClickLimiter, optionalFan, promoClick);

// Squads: 3–5 fans whose Beat Breaker month totals add up
router.get("/squads", optionalFan, listSquads);
router.get("/squads/invite/:code", squadInvite);
router.post("/squads", requireFan, bidLimiter, createSquad);
router.post("/squads/join", requireFan, bidLimiter, joinSquad);
router.post("/squads/leave", requireFan, leaveSquad);
router.post("/squads/remove", requireFan, removeFromSquad);

// Beat of the Day: the featured free beat (opens every game; triple points on its kicks in Beat Breaker)
router.get("/beat-of-the-day", beatOfTheDay);

// Game events: weekly challenges and live tournaments with their own boards and prizes
router.get("/events", listEvents);
router.get("/events/:slug", optionalFan, getEvent);

// Prize wallet: the winner's prize lands here; they withdraw it to Mobile Money
router.get("/wallet", requireFan, myWallet);
router.post("/wallet/withdraw", requireFan, checkoutLimiter, requestWithdrawal);
router.post("/wallet/withdrawals/:id/cancel", requireFan, cancelWithdrawal);

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

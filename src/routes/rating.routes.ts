import { Router } from "express";
import { listVideos, rateVideo, voteVideo } from "../controllers/rating.controller";
import { requireFan } from "../middleware/auth";

const router = Router();

router.get("/videos", listVideos); // public: content-creation videos + ratings + votes
router.post("/videos/:id/rate", requireFan, rateVideo); // fan: rate a video 1–5
router.post("/videos/:id/vote", requireFan, voteVideo); // fan: vote "best video"

export default router;

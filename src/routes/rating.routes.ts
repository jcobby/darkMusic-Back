import { Router } from "express";
import { listVideos, rateVideo } from "../controllers/rating.controller";
import { requireFan } from "../middleware/auth";

const router = Router();

router.get("/videos", listVideos); // public: content-creation videos + ratings
router.post("/videos/:id/rate", requireFan, rateVideo); // fan: rate a video

export default router;

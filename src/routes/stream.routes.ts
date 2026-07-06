import { Router } from "express";
import { streamSong } from "../controllers/stream.controller";
import { requireFan } from "../middleware/auth";

const router = Router();

router.get("/:slug", requireFan, streamSong);

export default router;

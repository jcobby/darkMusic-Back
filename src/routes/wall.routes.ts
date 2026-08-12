import { Router } from "express";
import { listWall, createPost, toggleLike, deleteOwnPost } from "../controllers/wall.controller";
import { requireFan } from "../middleware/auth";
import { upload } from "../services/upload";

const router = Router();

router.get("/", listWall); // public feed
router.post("/", requireFan, upload.single("photo"), createPost);
router.post("/:id/like", requireFan, toggleLike);
router.delete("/:id", requireFan, deleteOwnPost); // author deletes their own post

export default router;

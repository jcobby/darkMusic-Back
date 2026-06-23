import { Router } from "express";
import { createInquiry } from "../controllers/inquiry.controller";
import { inquiryLimiter } from "../middleware/rateLimit";

const router = Router();
router.post("/", inquiryLimiter, createInquiry);

export default router;

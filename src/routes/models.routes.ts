import { Router } from "express";
import { listModels, getModel } from "../controllers/models.controller";
import { createBooking } from "../controllers/bookings.controller";
import { requireFan } from "../middleware/auth";
import { inquiryLimiter } from "../middleware/rateLimit";

const router = Router();

router.get("/", listModels);
router.post("/bookings", requireFan, inquiryLimiter, createBooking); // signed-in customer requests a model
router.get("/:slug", getModel);

export default router;

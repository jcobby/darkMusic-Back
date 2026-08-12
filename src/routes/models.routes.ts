import { Router } from "express";
import { listModels, getModel, createBooking } from "../controllers/models.controller";
import { inquiryLimiter } from "../middleware/rateLimit";

const router = Router();

router.get("/", listModels);
router.post("/bookings", inquiryLimiter, createBooking); // client submits a booking request
router.get("/:slug", getModel);

export default router;

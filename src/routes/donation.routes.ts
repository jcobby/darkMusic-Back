import { Router } from "express";
import { initializeDonation, verifyDonation } from "../controllers/donation.controller";
import { checkoutLimiter } from "../middleware/rateLimit";

const router = Router();

router.post("/initialize", checkoutLimiter, initializeDonation);
router.get("/verify", verifyDonation);

export default router;

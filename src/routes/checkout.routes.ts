import { Router } from "express";
import { initialize, verify, webhook } from "../controllers/checkout.controller";
import { checkoutLimiter } from "../middleware/rateLimit";

const router = Router();

router.post("/initialize", checkoutLimiter, initialize);
router.get("/verify", verify);
router.post("/paystack/webhook", webhook);

export default router;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const checkout_controller_1 = require("../controllers/checkout.controller");
const rateLimit_1 = require("../middleware/rateLimit");
const router = (0, express_1.Router)();
router.post("/initialize", rateLimit_1.checkoutLimiter, checkout_controller_1.initialize);
router.get("/verify", checkout_controller_1.verify);
router.post("/paystack/webhook", checkout_controller_1.webhook);
exports.default = router;
//# sourceMappingURL=checkout.routes.js.map
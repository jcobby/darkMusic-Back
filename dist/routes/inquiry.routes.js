"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const inquiry_controller_1 = require("../controllers/inquiry.controller");
const rateLimit_1 = require("../middleware/rateLimit");
const router = (0, express_1.Router)();
router.post("/", rateLimit_1.inquiryLimiter, inquiry_controller_1.createInquiry);
exports.default = router;
//# sourceMappingURL=inquiry.routes.js.map
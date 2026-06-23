"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("../controllers/auth.controller");
const auth_1 = require("../middleware/auth");
const rateLimit_1 = require("../middleware/rateLimit");
const router = (0, express_1.Router)();
router.post("/login", rateLimit_1.loginLimiter, auth_controller_1.login);
router.get("/me", auth_1.requireAdmin, auth_controller_1.me);
exports.default = router;
//# sourceMappingURL=auth.routes.js.map
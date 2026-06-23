"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkoutLimiter = exports.inquiryLimiter = exports.loginLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const common = {
    windowMs: 15 * 60 * 1000, // 15 minutes
    standardHeaders: "draft-7",
    legacyHeaders: false,
};
/** Throttle admin login attempts to slow brute-force guessing. */
exports.loginLimiter = (0, express_rate_limit_1.default)({
    ...common,
    limit: 10,
    message: { message: "Too many login attempts. Please try again in a few minutes." },
});
/** Limit inquiry/contact submissions to curb spam. */
exports.inquiryLimiter = (0, express_rate_limit_1.default)({
    ...common,
    limit: 8,
    message: { message: "Too many submissions. Please try again later." },
});
/** Limit checkout initialization to prevent abuse / order spam. */
exports.checkoutLimiter = (0, express_rate_limit_1.default)({
    ...common,
    limit: 30,
    message: { message: "Too many checkout attempts. Please try again later." },
});
//# sourceMappingURL=rateLimit.js.map
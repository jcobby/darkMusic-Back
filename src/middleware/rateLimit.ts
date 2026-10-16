import rateLimit from "express-rate-limit";
import { clientIp } from "../utils/clientIp";

const common = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  // Count per visitor, not per proxy (req.ip is a shared proxy address on Render).
  keyGenerator: clientIp,
};

/** Throttle admin login attempts to slow brute-force guessing. */
export const loginLimiter = rateLimit({
  ...common,
  limit: 10,
  message: { message: "Too many login attempts. Please try again in a few minutes." },
});

/** Limit inquiry/contact submissions to curb spam. */
export const inquiryLimiter = rateLimit({
  ...common,
  limit: 8,
  message: { message: "Too many submissions. Please try again later." },
});

/** Limit checkout initialization to prevent abuse / order spam. */
export const checkoutLimiter = rateLimit({
  ...common,
  limit: 30,
  message: { message: "Too many checkout attempts. Please try again later." },
});

/** Limit merch auction bids per IP (plenty for a real bidding war, not for a bot). */
export const bidLimiter = rateLimit({
  ...common,
  limit: 60,
  message: { message: "Too many bids. Please wait a few minutes." },
});

/**
 * Game score saves, counted per signed-in player (use after requireFan). A run saves
 * at every level and every ~20 s, so this is far more than any real player sends.
 */
export const scoreLimiter = rateLimit({
  ...common,
  limit: 400,
  keyGenerator: (req) => (req.fan?.id ? `fan:${req.fan.id}` : clientIp(req)),
  message: { message: "Too many score saves — wait a minute and it'll save again." },
});

/** Limit content uploads (video/model submissions) to curb spam/storage abuse. */
export const uploadLimiter = rateLimit({
  ...common,
  limit: 15,
  message: { message: "Too many uploads. Please try again later." },
});

import rateLimit from "express-rate-limit";

const common = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
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

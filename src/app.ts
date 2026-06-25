import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env";
import { STORAGE, ensureStorageDirs } from "./services/storage";
import { notFound, errorHandler } from "./middleware/error.middleware";

import authRoutes from "./routes/auth.routes";
import catalogRoutes from "./routes/catalog.routes";
import inquiryRoutes from "./routes/inquiry.routes";
import checkoutRoutes from "./routes/checkout.routes";
import adminRoutes from "./routes/admin.routes";
import { download } from "./controllers/checkout.controller";

ensureStorageDirs();

const app = express();

// Trust the first proxy (needed for correct client IPs behind a host's load
// balancer, so rate limiting keys on the real IP).
app.set("trust proxy", 1);

app.use(
  helmet({
    // The API serves JSON + media (not HTML), and the frontend loads images/
    // audio from it cross-origin — so disable CSP and allow cross-origin reads.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser clients (no Origin) and any whitelisted frontend.
      if (!origin || env.clientUrls.includes(origin)) return callback(null, true);
      callback(null, false);
    },
  })
);
app.use(morgan("dev"));

// Capture the raw body so the Paystack webhook can verify its HMAC signature.
app.use(
  express.json({
    verify: (req: Request, _res, buf) => {
      (req as Request).rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// Public images (cover art, merch photos). Paid audio is never served here.
app.use("/uploads", express.static(STORAGE.images));

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/auth", authRoutes);
app.use("/api", catalogRoutes); // /releases, /beats, /merch
app.use("/api/inquiries", inquiryRoutes);
app.use("/api/checkout", checkoutRoutes);
app.use("/api/admin", adminRoutes);
app.get("/api/download/:token", download);

// 404 + centralized error handling (must be last)
app.use(notFound);
app.use(errorHandler);

export default app;

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const env_1 = require("./config/env");
const storage_1 = require("./services/storage");
const error_middleware_1 = require("./middleware/error.middleware");
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
const catalog_routes_1 = __importDefault(require("./routes/catalog.routes"));
const inquiry_routes_1 = __importDefault(require("./routes/inquiry.routes"));
const checkout_routes_1 = __importDefault(require("./routes/checkout.routes"));
const admin_routes_1 = __importDefault(require("./routes/admin.routes"));
const checkout_controller_1 = require("./controllers/checkout.controller");
(0, storage_1.ensureStorageDirs)();
const app = (0, express_1.default)();
// Trust the first proxy (needed for correct client IPs behind a host's load
// balancer, so rate limiting keys on the real IP).
app.set("trust proxy", 1);
app.use((0, helmet_1.default)({
    // The API serves JSON + media (not HTML), and the frontend loads images/
    // audio from it cross-origin — so disable CSP and allow cross-origin reads.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
}));
app.use((0, cors_1.default)({ origin: env_1.env.clientUrl }));
app.use((0, morgan_1.default)("dev"));
// Capture the raw body so the Paystack webhook can verify its HMAC signature.
app.use(express_1.default.json({
    verify: (req, _res, buf) => {
        req.rawBody = buf;
    },
}));
app.use(express_1.default.urlencoded({ extended: true }));
// Public images (cover art, merch photos). Paid audio is never served here.
app.use("/uploads", express_1.default.static(storage_1.STORAGE.images));
app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});
app.use("/api/auth", auth_routes_1.default);
app.use("/api", catalog_routes_1.default); // /releases, /beats, /merch
app.use("/api/inquiries", inquiry_routes_1.default);
app.use("/api/checkout", checkout_routes_1.default);
app.use("/api/admin", admin_routes_1.default);
app.get("/api/download/:token", checkout_controller_1.download);
// 404 + centralized error handling (must be last)
app.use(error_middleware_1.notFound);
app.use(error_middleware_1.errorHandler);
exports.default = app;
//# sourceMappingURL=app.js.map
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signAdminToken = signAdminToken;
exports.requireAdmin = requireAdmin;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
function signAdminToken(email) {
    return jsonwebtoken_1.default.sign({ email, role: "admin" }, env_1.env.jwtSecret, {
        expiresIn: "7d",
    });
}
/** Guards admin-only routes. Expects `Authorization: Bearer <jwt>`. */
function requireAdmin(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
        return res.status(401).json({ message: "Authentication required" });
    }
    try {
        const payload = jsonwebtoken_1.default.verify(token, env_1.env.jwtSecret);
        if (payload.role !== "admin") {
            return res.status(403).json({ message: "Forbidden" });
        }
        req.admin = { email: payload.email };
        next();
    }
    catch {
        return res.status(401).json({ message: "Invalid or expired token" });
    }
}
//# sourceMappingURL=auth.js.map
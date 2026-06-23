"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.login = login;
exports.me = me;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const env_1 = require("../config/env");
const auth_1 = require("../middleware/auth");
/**
 * Single-admin login. Credentials live in env (ADMIN_EMAIL / ADMIN_PASSWORD).
 * ADMIN_PASSWORD may be a plaintext value (hashed in-memory at boot) or a
 * pre-computed bcrypt hash (starts with "$2").
 */
const adminHash = env_1.env.adminPassword.startsWith("$2")
    ? env_1.env.adminPassword
    : bcryptjs_1.default.hashSync(env_1.env.adminPassword, 10);
async function login(req, res, next) {
    try {
        const { email, password } = req.body ?? {};
        if (!email || !password) {
            return res.status(400).json({ message: "Email and password are required" });
        }
        const emailMatches = String(email).toLowerCase() === env_1.env.adminEmail;
        const passwordMatches = await bcryptjs_1.default.compare(String(password), adminHash);
        if (!emailMatches || !passwordMatches) {
            return res.status(401).json({ message: "Invalid credentials" });
        }
        const token = (0, auth_1.signAdminToken)(env_1.env.adminEmail);
        res.json({ token, email: env_1.env.adminEmail });
    }
    catch (err) {
        next(err);
    }
}
async function me(req, res) {
    res.json({ email: req.admin?.email });
}
//# sourceMappingURL=auth.controller.js.map
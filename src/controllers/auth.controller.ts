import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { env } from "../config/env";
import { signAdminToken } from "../middleware/auth";

/**
 * Single-admin login. Credentials live in env (ADMIN_EMAIL / ADMIN_PASSWORD).
 * ADMIN_PASSWORD may be a plaintext value (hashed in-memory at boot) or a
 * pre-computed bcrypt hash (starts with "$2").
 */
const adminHash = env.adminPassword.startsWith("$2")
  ? env.adminPassword
  : bcrypt.hashSync(env.adminPassword, 10);

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }
    const emailMatches = String(email).toLowerCase() === env.adminEmail;
    const passwordMatches = await bcrypt.compare(String(password), adminHash);
    if (!emailMatches || !passwordMatches) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    const token = signAdminToken(env.adminEmail);
    res.json({ token, email: env.adminEmail });
  } catch (err) {
    next(err);
  }
}

export async function me(req: Request, res: Response) {
  res.json({ email: req.admin?.email });
}

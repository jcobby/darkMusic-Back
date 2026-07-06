import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

export interface AdminTokenPayload {
  email: string;
  role: "admin";
}

export function signAdminToken(email: string): string {
  return jwt.sign({ email, role: "admin" } as AdminTokenPayload, env.jwtSecret, {
    expiresIn: "7d",
  });
}

/** Guards admin-only routes. Expects `Authorization: Bearer <jwt>`. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    return res.status(401).json({ message: "Authentication required" });
  }
  try {
    const payload = jwt.verify(token, env.jwtSecret) as AdminTokenPayload;
    if (payload.role !== "admin") {
      return res.status(403).json({ message: "Forbidden" });
    }
    req.admin = { email: payload.email };
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

export interface FanTokenPayload {
  id: string;
  email: string;
  role: "fan";
}

export function signFanToken(id: string, email: string): string {
  return jwt.sign({ id, email, role: "fan" } as FanTokenPayload, env.jwtSecret, {
    expiresIn: "30d",
  });
}

/** Guards fan-only routes. Expects `Authorization: Bearer <jwt>`. */
export function requireFan(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    return res.status(401).json({ message: "Sign in required" });
  }
  try {
    const payload = jwt.verify(token, env.jwtSecret) as FanTokenPayload;
    if (payload.role !== "fan") {
      return res.status(403).json({ message: "Forbidden" });
    }
    req.fan = { id: payload.id, email: payload.email };
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

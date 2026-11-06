import { Request, Response, NextFunction } from "express";
import { MODELS_MARKET } from "../config/modelsMarket";

/** Blocks a models-marketplace route while the marketplace is closed (MODELS_MARKET.open). */
export function modelsOpen(_req: Request, res: Response, next: NextFunction) {
  if (MODELS_MARKET.open) return next();
  res.status(410).json({ message: "Model bookings are no longer offered on Dark Music Yard." });
}

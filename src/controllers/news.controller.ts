import { Request, Response, NextFunction } from "express";
import { getNews } from "../services/news";

/** GET /api/news — cached Ghana music / hip-hop / new-release headlines. */
export async function newsFeed(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await getNews());
  } catch (err) {
    next(err);
  }
}

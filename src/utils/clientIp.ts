import type { Request } from "express";

/**
 * The visitor's real IP address. On Render every request comes through Cloudflare
 * and then Render's own proxies, so `req.ip` is one of a few internal proxy
 * addresses, shared by everyone. Cloudflare puts the real address in
 * CF-Connecting-IP (and overwrites any value a client sends), so use that.
 */
export function clientIp(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  const ip = (Array.isArray(cf) ? cf[0] : cf)?.trim() || req.ip || "";
  return ip.replace(/^::ffff:/i, "");
}

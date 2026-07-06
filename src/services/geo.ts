/**
 * Best-effort country lookup for the live "countries" stat. Resolves an IP to
 * an ISO 3166-1 alpha-2 code (e.g. "GH") via ip-api.com's free endpoint, or
 * null. Never throws — countries are a nice-to-have, never critical path.
 */

// Skip loopback / private ranges — no meaningful country for these.
const PRIVATE_IP =
  /^(10\.|127\.|0\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i;

export async function lookupCountry(ip: string | undefined): Promise<string | null> {
  if (!ip) return null;
  // Normalise IPv4-mapped IPv6 (::ffff:1.2.3.4) and take the first of a list.
  const clean = ip.replace(/^::ffff:/i, "").split(",")[0].trim();
  if (!clean || PRIVATE_IP.test(clean)) return null;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(clean)}?fields=status,countryCode`,
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as { status?: string; countryCode?: string };
    if (json.status === "success" && json.countryCode) {
      return json.countryCode.toUpperCase();
    }
    return null;
  } catch {
    return null; // timeout, network error, rate-limit — silently skip
  }
}

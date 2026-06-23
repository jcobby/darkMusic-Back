import { env } from "../config/env";

/** Turn a stored image filename into a browser URL; pass through absolute URLs. */
export function imageUrl(value?: string): string | undefined {
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  return `${env.apiBaseUrl}/uploads/${value}`;
}

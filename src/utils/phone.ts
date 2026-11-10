/** Ghana mobile numbers (Mobile Money and texts). */

/** "0241234567" → "024 •••• 567" */
export const maskMomo = (n?: string) => (n ? `${n.slice(0, 3)} •••• ${n.slice(-3)}` : "");

/** Accepts 024 123 4567, +233 24 123 4567, 233241234567 … → "0241234567", or null. */
export function normalizeMomo(v: unknown): string | null {
  let d = String(v ?? "").replace(/\D/g, "");
  if (d.startsWith("233") && d.length === 12) d = `0${d.slice(3)}`;
  else if (d.length === 9) d = `0${d}`;
  return /^0[25]\d{8}$/.test(d) ? d : null;
}

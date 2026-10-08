/**
 * Branded, email-client-safe HTML for outgoing mail. Uses table layout and
 * inline styles (the only reliable approach across Gmail/Yahoo/Outlook/mobile).
 */

const ACCENT = "#d7191f"; // brand red (deep enough for white button text)
const INK = "#0b0f13";
const CARD = "#141b21";
const TEXT = "#e6e9ee";
const MUTED = "#9aa4b0";

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface EmailContent {
  title: string;
  intro?: string; // lead paragraph
  pre?: string; // preformatted details block (e.g. a booking's fields)
  button?: { label: string; url: string };
  note?: string; // small footnote (e.g. link expiry)
}

/** Plain-text fallback rendered from the same content. */
export function renderText(c: EmailContent): string {
  const out: string[] = [c.title, ""];
  if (c.intro) out.push(c.intro, "");
  if (c.pre) out.push(c.pre, "");
  if (c.button) out.push(`${c.button.label}: ${c.button.url}`, "");
  if (c.note) out.push(c.note);
  return out.join("\n").trim();
}

export function renderEmail(c: EmailContent): string {
  const button = c.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;">
         <tr><td style="border-radius:9999px;background:${ACCENT};">
           <a href="${c.button.url}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:9999px;">${escapeHtml(
             c.button.label
           )}</a>
         </td></tr>
       </table>
       <p style="margin:0 0 4px;color:${MUTED};font-size:12px;">Or paste this link into your browser:</p>
       <p style="margin:0;word-break:break-all;"><a href="${c.button.url}" style="color:${ACCENT};font-size:12px;">${escapeHtml(
         c.button.url
       )}</a></p>`
    : "";

  const pre = c.pre
    ? `<div style="margin:14px 0;padding:14px 16px;background:#0e141a;border-radius:12px;border:1px solid #232c34;color:${TEXT};font-size:14px;line-height:1.7;white-space:pre-wrap;">${escapeHtml(
        c.pre
      )}</div>`
    : "";

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:${INK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
        <tr><td style="padding:0 4px 16px;">
          <span style="font-size:15px;font-weight:800;letter-spacing:2px;color:${TEXT};">DARK MUSIC YARD</span>
        </td></tr>
        <tr><td style="background:${CARD};border-radius:16px;padding:28px 26px;">
          <h1 style="margin:0 0 12px;font-size:20px;color:${TEXT};">${escapeHtml(c.title)}</h1>
          ${c.intro ? `<p style="margin:0;color:${TEXT};font-size:15px;line-height:1.6;">${escapeHtml(c.intro)}</p>` : ""}
          ${pre}
          ${button}
          ${c.note ? `<p style="margin:18px 0 0;color:${MUTED};font-size:12px;line-height:1.5;">${escapeHtml(c.note)}</p>` : ""}
        </td></tr>
        <tr><td style="padding:16px 4px 0;color:${MUTED};font-size:11px;line-height:1.5;">
          © Dark Music Yard
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

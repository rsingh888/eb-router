import { getFromAddress, isResendConfigured } from "./config.js";

const RESEND_API_URL = "https://api.resend.com/emails";

export async function sendResendEmail({ to, subject, text, html }) {
  if (!isResendConfigured()) {
    return { sent: false, reason: "resend_not_configured" };
  }

  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = getFromAddress();
  const recipients = Array.isArray(to) ? to : [to];

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: recipients,
      subject,
      text,
      html: html || undefined,
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = payload?.message || payload?.error || res.statusText || "Resend request failed";
    throw new Error(`Resend error (${res.status}): ${message}`);
  }

  return { sent: true, id: payload?.id || null };
}

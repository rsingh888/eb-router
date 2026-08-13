import { isEmailConfigured, isResendConfigured, isSmtpConfigured } from "./config.js";
import { sendResendEmail } from "./resend.js";
import { sendSmtpEmail } from "./smtp.js";
import { inviteEmail, passwordResetEmail } from "./templates.js";

export { isEmailConfigured, isResendConfigured, isSmtpConfigured };

export async function sendEmail({ to, subject, text, html }) {
  if (!to) return { sent: false, reason: "missing_recipient" };

  if (isResendConfigured()) {
    return sendResendEmail({ to, subject, text, html });
  }
  if (isSmtpConfigured()) {
    return sendSmtpEmail({ to, subject, text, html });
  }

  console.info(`[email] Mail not configured — not sending to ${to}`);
  return { sent: false, reason: "email_not_configured" };
}

export async function sendPasswordResetEmail({ to, resetUrl }) {
  if (!isEmailConfigured()) {
    console.info(`[email] Mail not configured — password reset URL not emailed to ${to}`);
    console.info(`[email] Reset URL: ${resetUrl}`);
    return { sent: false, reason: "email_not_configured" };
  }

  const { subject, text, html } = passwordResetEmail({ resetUrl });
  return sendEmail({ to, subject, text, html });
}

export async function sendInviteEmail({ to, signupUrl, orgName, role, expiresInHours }) {
  if (!isEmailConfigured()) {
    console.info(`[email] Mail not configured — invite URL not emailed to ${to}`);
    console.info(`[email] Invite URL: ${signupUrl}`);
    return { sent: false, reason: "email_not_configured" };
  }

  const { subject, text, html } = inviteEmail({ signupUrl, orgName, role, expiresInHours });
  return sendEmail({ to, subject, text, html });
}

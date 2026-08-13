export function getFromAddress() {
  return String(process.env.EMAIL_FROM || process.env.SMTP_FROM || "").trim();
}

export function parseFromAddress(from) {
  const value = String(from || "").trim();
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim();
}

export function isResendConfigured() {
  return !!(String(process.env.RESEND_API_KEY || "").trim() && getFromAddress());
}

export function isSmtpConfigured() {
  return !!(process.env.SMTP_HOST && getFromAddress());
}

export function isEmailConfigured() {
  return isResendConfigured() || isSmtpConfigured();
}

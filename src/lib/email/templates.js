const BRAND = "#E56A4A";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout({ heading, bodyHtml, actionUrl, actionLabel, footer }) {
  const safeUrl = escapeHtml(actionUrl);
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f6f4f2;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4f2;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #ece8e4;">
          <tr>
            <td>
              <p style="margin:0 0 24px;font-size:18px;font-weight:700;color:${BRAND};">ebRouter</p>
              <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">${escapeHtml(heading)}</h1>
              ${bodyHtml}
              <p style="margin:28px 0;">
                <a href="${safeUrl}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">${escapeHtml(actionLabel)}</a>
              </p>
              <p style="margin:0 0 8px;font-size:13px;color:#666;word-break:break-all;">If the button does not work, copy this link:<br>${safeUrl}</p>
              <p style="margin:24px 0 0;font-size:12px;color:#888;">${escapeHtml(footer)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function passwordResetEmail({ resetUrl }) {
  const text = [
    "A password reset was requested for your ebRouter account.",
    "",
    `Reset your password: ${resetUrl}`,
    "",
    "This link expires in 1 hour. If you did not request this, ignore this email.",
  ].join("\n");

  const html = layout({
    heading: "Reset your password",
    bodyHtml: `<p style="margin:0 0 12px;line-height:1.6;">A password reset was requested for your ebRouter account. This link expires in 1 hour.</p>
              <p style="margin:0;line-height:1.6;">If you did not request this, you can ignore this email.</p>`,
    actionUrl: resetUrl,
    actionLabel: "Reset password",
    footer: "ebRouter · this link can be used only once",
  });

  return { subject: "Reset your ebRouter password", text, html };
}

export function inviteEmail({ signupUrl, orgName, role, expiresInHours = 168 }) {
  const team = orgName ? ` ${orgName}` : "";
  const roleLabel = role ? ` as ${role}` : "";
  const hours = Number(expiresInHours) || 168;
  const expiryLabel = hours % 24 === 0
    ? `${hours / 24} day${hours / 24 === 1 ? "" : "s"}`
    : `${hours} hours`;
  const text = [
    `You have been invited to join${team} on ebRouter${roleLabel}.`,
    "",
    `Accept the invite: ${signupUrl}`,
    "",
    `This link expires in ${expiryLabel}. If you were not expecting this, ignore this email.`,
  ].join("\n");

  const html = layout({
    heading: orgName ? `Join ${orgName} on ebRouter` : "You are invited to ebRouter",
    bodyHtml: `<p style="margin:0 0 12px;line-height:1.6;">You have been invited to join${escapeHtml(team)} on ebRouter${escapeHtml(roleLabel)}.</p>
              <p style="margin:0;line-height:1.6;">Create your account with the button below. This link expires in ${escapeHtml(expiryLabel)}.</p>`,
    actionUrl: signupUrl,
    actionLabel: "Accept invite",
    footer: "ebRouter · if you were not expecting this, ignore this email",
  });

  return { subject: orgName ? `You're invited to ${orgName} on ebRouter` : "You're invited to ebRouter", text, html };
}

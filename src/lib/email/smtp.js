// Optional SMTP delivery. Prefer Resend (RESEND_API_KEY) via src/lib/email/index.js.
import { getFromAddress, isSmtpConfigured, parseFromAddress } from "./config.js";

export { isSmtpConfigured };

export async function sendSmtpEmail({ to, subject, text, html }) {
  if (!isSmtpConfigured()) {
    return { sent: false, reason: "smtp_not_configured" };
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  const from = getFromAddress();
  const envelopeFrom = parseFromAddress(from);
  const secure = process.env.SMTP_SECURE === "true" || port === 465;
  const body = text || (html ? String(html).replace(/<[^>]+>/g, " ") : "");

  const { connect } = await import("node:net");
  const { connect: tlsConnect } = await import("node:tls");

  return new Promise((resolve, reject) => {
    let stage = "greet";
    let buffer = "";
    const socket = secure
      ? tlsConnect({ host, port, rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== "false" })
      : connect({ host, port });

    const send = (line) => socket.write(`${line}\r\n`);

    const fail = (err) => {
      socket.destroy();
      reject(err);
    };

    socket.on("error", fail);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\r\n")) {
        const idx = buffer.indexOf("\r\n");
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const code = Number(line.slice(0, 3));
        if (Number.isNaN(code)) continue;

        if (stage === "greet" && code === 220) {
          send(`EHLO ${host}`);
          stage = "ehlo";
        } else if (stage === "ehlo" && code === 250 && !line.startsWith("250-")) {
          if (user && pass) {
            send("AUTH LOGIN");
            stage = "auth-user";
          } else {
            send(`MAIL FROM:<${envelopeFrom}>`);
            stage = "mail-from";
          }
        } else if (stage === "auth-user" && code === 334) {
          send(Buffer.from(user).toString("base64"));
          stage = "auth-pass";
        } else if (stage === "auth-pass" && code === 334) {
          send(Buffer.from(pass).toString("base64"));
          stage = "auth-wait";
        } else if (stage === "auth-wait" && code === 235) {
          send(`MAIL FROM:<${envelopeFrom}>`);
          stage = "mail-from";
        } else if (stage === "mail-from" && code === 250) {
          send(`RCPT TO:<${to}>`);
          stage = "rcpt";
        } else if (stage === "rcpt" && code === 250) {
          send("DATA");
          stage = "data";
        } else if (stage === "data" && code === 354) {
          send(`From: ${from}`);
          send(`To: ${to}`);
          send(`Subject: ${subject}`);
          send("MIME-Version: 1.0");
          send("Content-Type: text/plain; charset=utf-8");
          send("");
          send(body);
          send(".");
          stage = "done";
        } else if (stage === "done" && code === 250) {
          send("QUIT");
          socket.end();
          resolve({ sent: true });
        } else if (code >= 400) {
          fail(new Error(`SMTP error: ${line}`));
        }
      }
    });
  });
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.SMTP_FROM;
  delete process.env.SMTP_HOST;
  delete process.env.APP_URL;
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("email config", () => {
  it("is unconfigured without Resend or SMTP", async () => {
    const email = await import("@/lib/email/index.js");
    expect(email.isEmailConfigured()).toBe(false);
    expect(email.isResendConfigured()).toBe(false);
    expect(email.isSmtpConfigured()).toBe(false);
  });

  it("detects Resend when API key and EMAIL_FROM are set", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "ebRouter <noreply@mail.equalbyte.io>";
    const { isEmailConfigured, isResendConfigured } = await import("@/lib/email/config.js");
    expect(isResendConfigured()).toBe(true);
    expect(isEmailConfigured()).toBe(true);
  });

  it("parses display-name From addresses", async () => {
    const { parseFromAddress, getFromAddress } = await import("@/lib/email/config.js");
    process.env.EMAIL_FROM = "ebRouter <noreply@mail.equalbyte.io>";
    expect(getFromAddress()).toBe("ebRouter <noreply@mail.equalbyte.io>");
    expect(parseFromAddress(getFromAddress())).toBe("noreply@mail.equalbyte.io");
  });
});

describe("email templates", () => {
  it("includes the reset URL in text and html", async () => {
    const { passwordResetEmail } = await import("@/lib/email/templates.js");
    const mail = passwordResetEmail({ resetUrl: "https://app.ebrouter.equalbyte.io/reset-password?token=abc" });
    expect(mail.subject).toMatch(/password/i);
    expect(mail.text).toContain("https://app.ebrouter.equalbyte.io/reset-password?token=abc");
    expect(mail.html).toContain("https://app.ebrouter.equalbyte.io/reset-password?token=abc");
  });

  it("includes org name and signup URL in invite mail", async () => {
    const { inviteEmail } = await import("@/lib/email/templates.js");
    const mail = inviteEmail({
      signupUrl: "https://acme.app.ebrouter.equalbyte.io/signup?token=xyz",
      orgName: "Acme",
      role: "member",
    });
    expect(mail.subject).toContain("Acme");
    expect(mail.text).toContain("https://acme.app.ebrouter.equalbyte.io/signup?token=xyz");
    expect(mail.html).toContain("Accept invite");
  });

  it("includes workspace login URL in org welcome mail", async () => {
    const { orgWelcomeEmail } = await import("@/lib/email/templates.js");
    const mail = orgWelcomeEmail({
      orgName: "Acme",
      orgSlug: "acme",
      loginUrl: "https://app.ebrouter.equalbyte.io/o/acme/login",
      adminName: "Ada",
    });
    expect(mail.subject).toContain("Acme");
    expect(mail.text).toContain("Hi Ada,");
    expect(mail.text).toContain("https://app.ebrouter.equalbyte.io/o/acme/login");
    expect(mail.html).toContain("/o/acme");
    expect(mail.html).toContain("Sign in to your workspace");
  });
});

describe("public URL", () => {
  it("prefers APP_URL over BASE_URL", async () => {
    process.env.APP_URL = "https://app.ebrouter.equalbyte.io/";
    process.env.BASE_URL = "http://localhost:20128";
    const { getConfiguredPublicUrl } = await import("@/lib/publicUrl.js");
    expect(getConfiguredPublicUrl()).toBe("https://app.ebrouter.equalbyte.io");
  });
});

describe("Resend send", () => {
  it("posts to api.resend.com with from/to/subject", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "ebRouter <noreply@mail.equalbyte.io>";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { sendEmail } = await import("@/lib/email/index.js");
    const result = await sendEmail({
      to: "user@example.com",
      subject: "Hello",
      text: "Hi",
      html: "<p>Hi</p>",
    });

    expect(result).toEqual({ sent: true, id: "email_1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer re_test");
    expect(JSON.parse(init.body)).toMatchObject({
      from: "ebRouter <noreply@mail.equalbyte.io>",
      to: ["user@example.com"],
      subject: "Hello",
    });
  });

  it("returns not-configured without throwing when mail is unset", async () => {
    const { sendPasswordResetEmail } = await import("@/lib/email/index.js");
    const result = await sendPasswordResetEmail({
      to: "user@example.com",
      resetUrl: "https://app.example.com/reset-password?token=abc",
    });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("email_not_configured");
  });
});

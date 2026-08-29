import { NextResponse } from "next/server";
import { isSaas, isSaasOpenRegistration } from "@/lib/deploy/deployMode.js";
import { normalizeOrgSlug, validateOrgSlug } from "@/lib/org/slug.js";
import { buildOrgDashboardUrl } from "@/lib/org/orgContext.js";
import { createOrganization, isSlugAvailable } from "@/lib/db/repos/organizationsRepo.js";
import { createOrgSettings } from "@/lib/db/repos/settingsRepo.js";
import { createUser } from "@/lib/db/repos/usersRepo.js";
import { validatePassword } from "@/lib/auth/passwordPolicy";
import { auditFromRequest, AuditAction } from "@/lib/audit";
import { isEmailConfigured, sendOrgWelcomeEmail } from "@/lib/email/index.js";
import { consumeRateLimit } from "@/lib/auth/sharedRateLimit.js";
import { getClientIp } from "@/lib/auth/loginLimiter";

export async function POST(request) {
  if (!isSaas()) {
    return NextResponse.json({ error: "Organization registration is only available in SaaS mode" }, { status: 404 });
  }
  if (!isSaasOpenRegistration()) {
    return NextResponse.json(
      { error: "Public organization registration is disabled. Ask your administrator for an invite." },
      { status: 403 },
    );
  }

  const ip = getClientIp(request);
  const limit = await consumeRateLimit({
    scope: "register-org",
    key: ip,
    windowMs: 60 * 60 * 1000,
    limit: 5,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many registration attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  try {
    const body = await request.json();
    const orgName = String(body.orgName || body.name || "").trim();
    const orgSlug = normalizeOrgSlug(body.orgSlug || body.slug || orgName);
    const email = String(body.email || "").trim().toLowerCase();
    const name = String(body.name || body.adminName || email.split("@")[0] || "").trim();
    const password = body.password;

    if (!orgName || !orgSlug || !email || !password) {
      return NextResponse.json({ error: "Organization name, slug, email, and password are required" }, { status: 400 });
    }

    const slugCheck = validateOrgSlug(orgSlug);
    if (!slugCheck.ok) {
      return NextResponse.json({ error: slugCheck.error }, { status: 400 });
    }

    if (!(await isSlugAvailable(orgSlug))) {
      return NextResponse.json({ error: "This organization URL is already taken" }, { status: 409 });
    }

    const passwordCheck = validatePassword(password);
    if (!passwordCheck.ok) {
      return NextResponse.json({ error: passwordCheck.error }, { status: 400 });
    }

    const org = await createOrganization({ slug: orgSlug, name: orgName });
    if (!org?.id) {
      return NextResponse.json({ error: "Failed to create organization" }, { status: 500 });
    }

    await createOrgSettings(org.id, {
      multiUserEnabled: true,
      signupMode: "invite",
      requireLogin: true,
    });

    const user = await createUser({
      orgId: org.id,
      email,
      name,
      password,
      role: "admin",
      requireOrgId: true,
    });

    const loginUrl = buildOrgDashboardUrl(org.slug, "/login", { request });
    const dashboardUrl = buildOrgDashboardUrl(org.slug, "/dashboard", { request });
    const publicLoginUrl = buildOrgDashboardUrl(org.slug, "/login", { forcePublic: true }) || loginUrl;

    let emailed = false;
    if (isEmailConfigured()) {
      try {
        const mail = await sendOrgWelcomeEmail({
          to: user.email,
          orgName: org.name,
          orgSlug: org.slug,
          loginUrl: publicLoginUrl,
          adminName: user.name,
        });
        emailed = !!mail.sent;
      } catch (mailError) {
        console.error("[email] Failed to send org welcome:", mailError.message);
      }
    }

    await auditFromRequest(request, {
      action: AuditAction.USER_CREATED,
      actorUserId: user.id,
      actorEmail: user.email,
      targetType: "organization",
      targetId: org.id,
      meta: { slug: org.slug, bootstrap: true, emailed },
    });

    return NextResponse.json({
      success: true,
      organization: { id: org.id, slug: org.slug, name: org.name },
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      loginUrl,
      dashboardUrl,
      emailed,
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Registration failed" }, { status: 400 });
  }
}

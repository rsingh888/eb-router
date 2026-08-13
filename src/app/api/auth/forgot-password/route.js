import { NextResponse } from "next/server";
import { requestPasswordReset } from "@/lib/auth/passwordReset";
import { auditFromRequest, AuditAction } from "@/lib/audit";
import { resolveOrgFromRequest } from "@/lib/org/orgContext.js";
import { runWithOrgId } from "@/lib/auth/runtimeUserContext.js";
import { getOrganizationBySlug } from "@/lib/db/repos/organizationsRepo.js";
import { isSaas } from "@/lib/deploy/deployMode.js";

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const bodyOrgSlug = String(body.orgSlug || "").trim().toLowerCase();

  let org = await resolveOrgFromRequest(request);
  if (!org && bodyOrgSlug) {
    org = await getOrganizationBySlug(bodyOrgSlug);
  }
  if (!org) {
    if (isSaas()) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Organization not configured" }, { status: 503 });
  }

  return runWithOrgId(org.id, async () => {
    try {
      const normalizedEmail = String(body.email || "").trim().toLowerCase();
      if (!normalizedEmail) {
        return NextResponse.json({ error: "Email is required" }, { status: 400 });
      }

      await requestPasswordReset(normalizedEmail, { orgId: org.id, request });
      await auditFromRequest(request, {
        action: AuditAction.PASSWORD_RESET_REQUESTED,
        actorEmail: normalizedEmail,
        targetType: "user",
        outcome: "success",
        meta: { orgId: org.id },
      });

      return NextResponse.json({
        success: true,
        message: "If an account exists for that email, a reset link has been sent or can be issued by an admin.",
      });
    } catch (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  });
}

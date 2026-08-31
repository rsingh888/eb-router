import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, toPublicApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { withAuthUser } from "@/lib/auth/runtimeUserContext.js";
import { auditFromRequest, AuditAction } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const GET = withAuthUser(async (_request, _ctx, user) => {
  try {
    const keys = await getApiKeys(user.id);
    return NextResponse.json({ keys: keys.map((k) => toPublicApiKey(k)) });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
});

export const POST = withAuthUser(async (request, _ctx, user) => {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId, user.id, user.orgId);

    await auditFromRequest(request, {
      action: AuditAction.API_KEY_CREATED,
      actorUserId: user.id,
      actorEmail: user.email,
      targetType: "api_key",
      targetId: apiKey.id,
      meta: { name: apiKey.name },
    });

    return NextResponse.json(toPublicApiKey(apiKey, { includeSecret: true }), { status: 201 });
  } catch (error) {
    console.error("Error creating key:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to create key" },
      { status: 500 },
    );
  }
});

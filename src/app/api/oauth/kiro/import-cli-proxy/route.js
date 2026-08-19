import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { withAuthUser } from "@/lib/auth/runtimeUserContext.js";
import { normalizeKiroExternalIdpAuth } from "@/lib/oauth/kiroExternalIdp";

/**
 * POST /api/oauth/kiro/import-cli-proxy
 * Import Kiro CLIProxyAPI auth JSON for Microsoft external_idp accounts.
 */
export const POST = withAuthUser(async (request, _ctx, user) => {
  try {
    const body = await request.json();
    const rawAuth = body?.cliProxyAuth ?? body?.auth ?? body?.json ?? body;
    const tokenData = normalizeKiroExternalIdpAuth(rawAuth);

    const connection = await createProviderConnection({
      userId: user.id,
      orgId: user.orgId,
      provider: "kiro",
      authType: "oauth",
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: tokenData.expiresAt,
      email: tokenData.email || null,
      providerSpecificData: tokenData.providerSpecificData,
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "CLIProxyAPI import failed" },
      { status: 400 }
    );
  }
});

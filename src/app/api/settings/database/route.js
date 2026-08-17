import { NextResponse } from "next/server";
import {
  createBackupDownload,
  getDatabaseInfo,
  importDb,
  getSettings,
  RESTORE_CONFIRM_TEXT,
} from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { withAuthUser } from "@/lib/auth/runtimeUserContext";
import { AuditAction, auditFromRequest } from "@/lib/audit";
import { MIN_BACKUP_PASSPHRASE_LENGTH } from "@/lib/db/backupCrypto.js";

function actorMeta(user) {
  return {
    actorUserId: user.id,
    actorEmail: user.email,
    orgId: user.orgId,
  };
}

export const GET = withAuthUser(async (request, _ctx, user) => {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("info") === "1") {
      const info = getDatabaseInfo();
      return NextResponse.json({
        ...info,
        backupScope: user.role === "admin" ? "org" : "user",
        isAdmin: user.role === "admin",
        sealed: true,
        minPassphraseLength: MIN_BACKUP_PASSPHRASE_LENGTH,
        confirmTextRequired: RESTORE_CONFIRM_TEXT,
        note: "Profile backups are tenant-scoped data exports. Platform disaster recovery uses deploy backup scripts / managed Postgres snapshots — not this UI.",
      });
    }

    return NextResponse.json(
      { error: "Use POST with action=export and a passphrase to download an encrypted backup." },
      { status: 405 }
    );
  } catch (error) {
    console.log("Error reading database backup info:", error);
    return NextResponse.json({ error: error?.message || "Failed to read backup info" }, { status: 500 });
  }
});

export const POST = withAuthUser(async (request, _ctx, user) => {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/sql") || contentType.includes("text/plain")) {
      return NextResponse.json(
        { error: "Full SQL backups are not supported. Import an encrypted tenant JSON backup from Profile." },
        { status: 400 }
      );
    }

    const body = await request.json();
    const action = body?.action || "import";

    if (action === "export") {
      const backup = await createBackupDownload(user, {
        passphrase: body.passphrase,
        includeHeavyData: body.includeHeavyData === true,
      });

      await auditFromRequest(request, {
        action: AuditAction.BACKUP_EXPORTED,
        ...actorMeta(user),
        targetType: "backup",
        targetId: user.orgId,
        outcome: "success",
        meta: {
          scope: backup.scope,
          includeHeavyData: body.includeHeavyData === true,
          rowCounts: backup.meta?.rowCounts || {},
        },
      });

      return new NextResponse(backup.content, {
        headers: {
          "Content-Type": backup.contentType,
          "Content-Disposition": `attachment; filename="${backup.filename}"`,
          "X-Backup-Format": backup.format,
          "X-Backup-Scope": backup.scope,
          "X-Backup-Sealed": "1",
        },
      });
    }

    if (action === "preview" || action === "import") {
      const backup = body.backup;
      if (!backup || typeof backup !== "object") {
        return NextResponse.json({ error: "Missing backup payload" }, { status: 400 });
      }

      try {
        const result = await importDb(backup, user, {
          passphrase: body.passphrase,
          dryRun: action === "preview",
          confirmText: body.confirmText,
        });

        await auditFromRequest(request, {
          action: action === "preview" ? AuditAction.BACKUP_IMPORT_PREVIEW : AuditAction.BACKUP_IMPORTED,
          ...actorMeta(user),
          targetType: "backup",
          targetId: user.orgId,
          outcome: "success",
          meta: {
            scope: result?.scope || backup?.meta?.scope || null,
            dryRun: action === "preview",
            willDelete: result?.willDelete || null,
            willInsert: result?.willInsert || null,
          },
        });

        if (action === "preview") {
          return NextResponse.json(result);
        }

        try {
          const settings = await getSettings(user.orgId);
          applyOutboundProxyEnv(settings);
        } catch (err) {
          console.warn("[Settings][DatabaseImport] Failed to re-apply outbound proxy env:", err);
        }

        return NextResponse.json({
          success: true,
          scope: result?.scope || (user.role === "admin" ? "org" : "user"),
        });
      } catch (err) {
        await auditFromRequest(request, {
          action: AuditAction.BACKUP_IMPORT_FAILED,
          ...actorMeta(user),
          targetType: "backup",
          targetId: user.orgId,
          outcome: "failure",
          meta: {
            stage: action,
            error: err?.message || "import failed",
          },
        });
        throw err;
      }
    }

    return NextResponse.json({ error: "Unknown action. Use export, preview, or import." }, { status: 400 });
  } catch (error) {
    console.log("Error handling database backup:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to process backup" },
      { status: 400 }
    );
  }
});

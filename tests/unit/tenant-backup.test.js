import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-tenant-backup-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("tenant-scoped backups", () => {
  async function seedTwoOrgs() {
    const db = await import("@/lib/db/index.js");
    const { runWithContext } = await import("@/lib/auth/runtimeUserContext.js");
    await db.initDb();

    const orgA = await db.createOrganization({ slug: "acme", name: "Acme" });
    const orgB = await db.createOrganization({ slug: "beta", name: "Beta" });
    await db.createOrgSettings(orgA.id, { requireLogin: true });
    await db.createOrgSettings(orgB.id, { requireLogin: true });

    const adminA = await db.createUser({
      orgId: orgA.id, email: "admin@acme.com", name: "AdminA", password: "Password123", role: "admin",
    });
    const memberA = await db.createUser({
      orgId: orgA.id, email: "member@acme.com", name: "MemberA", password: "Password123", role: "member",
    });
    const adminB = await db.createUser({
      orgId: orgB.id, email: "admin@beta.com", name: "AdminB", password: "Password123", role: "admin",
    });

    await runWithContext({ orgId: orgA.id, userId: adminA.id }, async () => {
      await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "acme-admin-conn", apiKey: "k-admin-a" });
      await db.createCombo({ name: "acme-admin-combo", models: ["gpt-4"] });
      await db.createApiKey("acme-admin-key", "m1", adminA.id);
    });

    await runWithContext({ orgId: orgA.id, userId: memberA.id }, async () => {
      await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "acme-member-conn", apiKey: "k-member-a" });
      await db.createCombo({ name: "acme-member-combo", models: ["gpt-4o-mini"] });
      await db.createApiKey("acme-member-key", "m1", memberA.id);
    });

    await runWithContext({ orgId: orgB.id, userId: adminB.id }, async () => {
      await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "beta-conn", apiKey: "k-beta" });
      await db.createCombo({ name: "beta-combo", models: ["gpt-4o"] });
      await db.createApiKey("beta-key", "m1", adminB.id);
    });

    return { db, orgA, orgB, adminA, memberA, adminB };
  }

  it("admin org backup excludes other organizations", async () => {
    const { db, adminA, orgB } = await seedTwoOrgs();
    const payload = await db.exportTenantBackup(adminA);

    expect(payload.format).toBe("ebrouter-backup-v3");
    expect(payload.scope).toBe("org");
    expect(payload.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.tables.providerConnections.map((c) => c.name).sort()).toEqual([
      "acme-admin-conn",
      "acme-member-conn",
    ]);
    expect(payload.tables.users.map((u) => u.email).sort()).toEqual([
      "admin@acme.com",
      "member@acme.com",
    ]);
    expect(payload.tables.providerConnections.some((c) => c.orgId === orgB.id)).toBe(false);
    expect(payload.tables.users.some((u) => u.orgId === orgB.id)).toBe(false);
    expect(payload.tables.usageHistory).toEqual([]);
    expect(payload.tables.requestDetails).toEqual([]);
    expect(payload.tables.auditLogs).toEqual([]);
  }, 20000);

  it("member backup includes only their own rows", async () => {
    const { db, memberA } = await seedTwoOrgs();
    const payload = await db.exportTenantBackup(memberA);

    expect(payload.scope).toBe("user");
    expect(payload.userId).toBe(memberA.id);
    expect(payload.tables.providerConnections.map((c) => c.name)).toEqual(["acme-member-conn"]);
    expect(payload.tables.combos.map((c) => c.name)).toEqual(["acme-member-combo"]);
    expect(payload.tables.apiKeys.map((k) => k.name)).toEqual(["acme-member-key"]);
    expect(payload.tables.users).toBeUndefined();
    expect(payload.tables.settings).toBeUndefined();
    expect(payload.tables.providerNodes).toBeUndefined();
  }, 20000);

  it("sealed backup roundtrips with passphrase and rejects wrong passphrase", async () => {
    const { db, adminA } = await seedTwoOrgs();
    const { sealBackup, unsealBackup } = await import("@/lib/db/backupCrypto.js");
    const plain = await db.exportTenantBackup(adminA);
    const sealed = await sealBackup(plain, "correct-horse-battery");

    expect(sealed.format).toBe("ebrouter-backup-v3-sealed");
    expect(sealed.ciphertext).toBeTruthy();
    expect(JSON.stringify(sealed)).not.toContain("acme-admin-conn");

    const opened = await unsealBackup(sealed, "correct-horse-battery");
    expect(opened.tables.providerConnections.map((c) => c.name).sort()).toEqual([
      "acme-admin-conn",
      "acme-member-conn",
    ]);

    await expect(unsealBackup(sealed, "wrong-passphrase!!")).rejects.toThrow(/passphrase|corrupted/i);
  }, 20000);

  it("preview reports destructive impact and import requires RESTORE confirm", async () => {
    const { db, orgA, adminA } = await seedTwoOrgs();
    const { runWithContext } = await import("@/lib/auth/runtimeUserContext.js");
    const snap = await db.exportTenantBackup(adminA);

    await runWithContext({ orgId: orgA.id, userId: adminA.id }, async () => {
      await db.createProviderConnection({
        provider: "anthropic", authType: "apikey", name: "acme-extra", apiKey: "k-extra",
      });
    });

    const preview = await db.previewTenantBackup(snap, adminA);
    expect(preview.dryRun).toBe(true);
    expect(preview.willDelete.providerConnections).toBeGreaterThanOrEqual(3);
    expect(preview.willInsert.providerConnections).toBe(2);
    expect(preview.confirmTextRequired).toBe("RESTORE");

    await expect(db.importTenantBackup(snap, adminA)).rejects.toThrow(/RESTORE/);
    await expect(db.importTenantBackup(snap, adminA, { confirmText: "yes" })).rejects.toThrow(/RESTORE/);

    await db.importTenantBackup(snap, adminA, { confirmText: "RESTORE" });
    const restored = await db.exportTenantBackup(adminA);
    expect(restored.tables.providerConnections.map((c) => c.name).sort()).toEqual([
      "acme-admin-conn",
      "acme-member-conn",
    ]);
  }, 20000);

  it("restoring org backup does not wipe another organization", async () => {
    const { db, orgA, adminA, adminB } = await seedTwoOrgs();
    const { runWithContext } = await import("@/lib/auth/runtimeUserContext.js");

    const snap = await db.exportTenantBackup(adminA);

    await runWithContext({ orgId: orgA.id, userId: adminA.id }, async () => {
      await db.createProviderConnection({
        provider: "anthropic", authType: "apikey", name: "acme-extra", apiKey: "k-extra",
      });
    });

    await db.importTenantBackup(snap, adminA, { confirmText: "RESTORE" });

    const restored = await db.exportTenantBackup(adminA);
    const bBackup = await db.exportTenantBackup(adminB);

    expect(restored.tables.providerConnections.map((c) => c.name).sort()).toEqual([
      "acme-admin-conn",
      "acme-member-conn",
    ]);
    expect(bBackup.tables.providerConnections.map((c) => c.name)).toEqual(["beta-conn"]);
  }, 20000);

  it("member cannot import an organization backup", async () => {
    const { db, adminA, memberA } = await seedTwoOrgs();
    const orgBackup = await db.exportTenantBackup(adminA);

    await expect(
      db.importTenantBackup(orgBackup, memberA, { confirmText: "RESTORE" })
    ).rejects.toThrow(/admins/i);
  }, 20000);

  it("member cannot import another org's user backup", async () => {
    const { db, memberA, adminB } = await seedTwoOrgs();
    const foreign = await db.exportTenantBackup({ ...adminB, role: "member" });

    await expect(
      db.importTenantBackup(foreign, memberA, { confirmText: "RESTORE" })
    ).rejects.toThrow(/different organization/i);
  }, 20000);

  it("tampered plaintext backup fails checksum", async () => {
    const { db, adminA } = await seedTwoOrgs();
    const snap = await db.exportTenantBackup(adminA);
    snap.tables.providerConnections.push({ id: "evil", name: "injected" });

    await expect(
      db.importTenantBackup(snap, adminA, { confirmText: "RESTORE" })
    ).rejects.toThrow(/checksum|tampered/i);
  }, 20000);

  it("importDb with actor rejects full SQL and v2 dumps", async () => {
    const { db, adminA } = await seedTwoOrgs();
    await expect(db.importDb("BEGIN; SELECT 1;", adminA)).rejects.toThrow(/SQL/i);
    await expect(db.importDb({ format: "ebrouter-backup-v2", tables: {} }, adminA)).rejects.toThrow(/Full-database/i);
  }, 20000);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-apikey-ctx-"));
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

describe("API key request context", () => {
  it("resolveRequestContext stamps orgId so provider connections are visible", async () => {
    const db = await import("@/lib/db/index.js");
    const { runWithContext } = await import("@/lib/auth/runtimeUserContext.js");
    const { resolveRequestContext } = await import("@/sse/services/auth.js");

    await db.initDb();

    const orgA = await db.createOrganization({ slug: "tenant-a", name: "Tenant A" });
    const orgB = await db.createOrganization({ slug: "tenant-b", name: "Tenant B" });
    await db.createOrgSettings(orgA.id, { requireLogin: true, signupMode: "invite" });
    await db.createOrgSettings(orgB.id, { requireLogin: true, signupMode: "invite" });

    const userA = await db.createUser({
      orgId: orgA.id,
      email: "a@tenant-a.com",
      name: "A",
      password: "Password123",
      role: "admin",
    });

    let apiKeyPlain;
    await runWithContext({ orgId: orgA.id, userId: userA.id }, async () => {
      await db.createProviderConnection({
        provider: "groq",
        authType: "apikey",
        name: "my-groq",
        apiKey: "gsk-test",
      });
      const key = await db.createApiKey("cursor-key", "machine-1", userA.id, orgA.id);
      apiKeyPlain = key.key;
    });

    const ctx = await resolveRequestContext(apiKeyPlain);
    expect(ctx.userId).toBe(userA.id);
    expect(ctx.orgId).toBe(orgA.id);

    const scoped = await runWithContext(ctx, () => db.getProviderConnections({ provider: "groq" }));
    expect(scoped).toHaveLength(1);
    expect(scoped[0].name).toBe("my-groq");

    // Without orgId in context, tenant B / default org must not see tenant A's Groq key.
    const wrongOrg = await runWithContext({ userId: userA.id, orgId: orgB.id }, () =>
      db.getProviderConnections({ provider: "groq" }),
    );
    expect(wrongOrg).toHaveLength(0);
  }, 20000);
});

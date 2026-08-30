import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveUsageFilterUserId, USAGE_SCOPE_ALL, USAGE_SCOPE_MINE } from "@/lib/auth/usageScope.js";

let tempDir;
const originalEnv = {};

function snapshotEnv(keys) {
  for (const key of keys) originalEnv[key] = process.env[key];
}

function restoreEnv(keys) {
  for (const key of keys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

const ENV_KEYS = [
  "DATA_DIR",
  "DATABASE_URL",
  "DEPLOY_MODE",
  "ALLOW_SQLITE_FALLBACK",
  "OBSERVABILITY_ENABLED",
];

beforeEach(() => {
  snapshotEnv(ENV_KEYS);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-toggles-"));
  process.env.DATA_DIR = tempDir;
  delete process.env.DATABASE_URL;
  process.env.DEPLOY_MODE = "onprem";
  process.env.ALLOW_SQLITE_FALLBACK = "true";
  process.env.OBSERVABILITY_ENABLED = "true";
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  restoreEnv(ENV_KEYS);
});

async function bootOrg() {
  const db = await import("@/lib/db/index.js");
  const { runWithContext } = await import("@/lib/auth/runtimeUserContext.js");
  await db.initDb();
  const org = await db.createOrganization({ slug: "acme", name: "Acme" });
  await db.createOrgSettings(org.id, { requireLogin: true, signupMode: "invite" });
  const admin = await db.createUser({
    orgId: org.id, email: "admin@acme.com", name: "Admin",
    password: "Password123", role: "admin",
  });
  const member = await db.createUser({
    orgId: org.id, email: "member@acme.com", name: "Member",
    password: "Password123", role: "member",
  });
  return { db, runWithContext, org, admin, member };
}

describe("usage scope resolver", () => {
  it("members always see only their own rows even if they pass scope=all", () => {
    const member = { id: "u-member", role: "member" };
    expect(resolveUsageFilterUserId(member, USAGE_SCOPE_ALL)).toBe("u-member");
    expect(resolveUsageFilterUserId(member, USAGE_SCOPE_MINE)).toBe("u-member");
  });

  it("admins can open org-wide stats with scope=all", () => {
    const admin = { id: "u-admin", role: "admin" };
    expect(resolveUsageFilterUserId(admin, USAGE_SCOPE_ALL)).toBeNull();
    expect(resolveUsageFilterUserId(admin, USAGE_SCOPE_MINE)).toBe("u-admin");
  });
});

describe("dashboard toggles persist and are read back", () => {
  it("org toggles used by chat/guard/token-saver round-trip through settings", async () => {
    const { db, runWithContext, org, admin } = await bootOrg();

    const patches = {
      requireLogin: false,
      requireApiKey: true,
      tunnelDashboardAccess: false,
      outboundProxyEnabled: true,
      rtkEnabled: false,
      prefixCacheEnabled: false,
      cavemanEnabled: true,
      cavemanLevel: "light",
      compactPoliciesEnabled: true,
      promptDedupEnabled: true,
      contextPruningEnabled: true,
      contextPruningKeepLast: 12,
      modelRoutingEnabled: true,
      fallbackStrategy: "round-robin",
      comboStrategy: "round-robin",
      stickyRoundRobinLimit: 5,
      comboStickyRoundRobinLimit: 4,
    };

    await runWithContext({ orgId: org.id, userId: admin.id }, () => db.updateSettings(patches));
    const settings = await runWithContext({ orgId: org.id, userId: admin.id }, () => db.getSettings());

    for (const [key, value] of Object.entries(patches)) {
      expect(settings[key], key).toEqual(value);
    }
  }, 20000);

  it("profile observability toggle is per-user and actually gates requestDetails writes", async () => {
    const { db, runWithContext, org, admin, member } = await bootOrg();
    const ctx = { orgId: org.id, userId: admin.id };

    await runWithContext(ctx, () => db.updateUserSettings(admin.id, {
      enableObservability: false,
      observabilityBatchSize: 1,
    }));

    await runWithContext(ctx, () => db.saveRequestDetail({
      id: "off-1",
      provider: "openai",
      model: "gpt-4",
      status: "ok",
      request: { messages: [{ role: "user", content: "secret prompt" }] },
      response: { status: 200 },
    }));
    await new Promise((r) => setTimeout(r, 250));

    const off = await runWithContext(ctx, () => db.getRequestDetailById("off-1"));
    expect(off).toBeNull();

    await runWithContext(ctx, () => db.updateUserSettings(admin.id, { enableObservability: true }));
    await runWithContext(ctx, () => db.saveRequestDetail({
      id: "on-1",
      provider: "openai",
      model: "gpt-4",
      status: "ok",
      request: { messages: [{ role: "user", content: "hello" }] },
      response: { status: 200 },
    }));
    await new Promise((r) => setTimeout(r, 250));

    const on = await runWithContext(ctx, () => db.getRequestDetailById("on-1"));
    expect(on).toBeTruthy();
    expect(on.request.messages[0].content).toBe("hello");

    const memberEffective = await runWithContext({ orgId: org.id, userId: member.id }, () =>
      db.getEffectiveSettings(member.id),
    );
    expect(memberEffective.enableObservability).toBe(true);
  }, 20000);

  it("connection and proxy-pool isActive toggles hide them from routing queries", async () => {
    const { db, runWithContext, org, admin } = await bootOrg();
    const ctx = { orgId: org.id, userId: admin.id };

    const conn = await runWithContext(ctx, () => db.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "acct-1",
      apiKey: "sk-test",
      isActive: true,
    }));
    const pool = await runWithContext(ctx, () => db.createProxyPool({
      name: "pool-1",
      type: "http",
      proxyUrl: "http://127.0.0.1:7890",
      isActive: true,
    }));

    await runWithContext(ctx, () => db.updateProviderConnection(conn.id, { isActive: false }));
    await runWithContext(ctx, () => db.updateProxyPool(pool.id, { isActive: false }));

    const activeConns = await runWithContext(ctx, () => db.getProviderConnections({ provider: "openai", isActive: true }));
    const activePools = await runWithContext(ctx, () => db.getProxyPools({ isActive: true }));
    expect(activeConns.map((c) => c.id)).not.toContain(conn.id);
    expect(activePools.map((p) => p.id)).not.toContain(pool.id);

    const allConns = await runWithContext(ctx, () => db.getProviderConnections({ provider: "openai" }));
    expect(allConns.find((c) => c.id === conn.id).isActive).toBe(false);
  }, 20000);
});

describe("per-user usage history stats", () => {
  it("each user sees only their token totals; admin scope=all sees both", async () => {
    const { db, runWithContext, org, admin, member } = await bootOrg();

    await runWithContext({ orgId: org.id, userId: admin.id }, () => db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      tokens: { prompt_tokens: 100, completion_tokens: 20 },
      status: "ok",
    }));
    await runWithContext({ orgId: org.id, userId: member.id }, () => db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4o-mini",
      tokens: { prompt_tokens: 7, completion_tokens: 3 },
      status: "ok",
    }));

    const adminMine = await runWithContext({ orgId: org.id, userId: admin.id }, () =>
      db.getUsageStats("24h", resolveUsageFilterUserId(admin, USAGE_SCOPE_MINE)),
    );
    const memberMine = await runWithContext({ orgId: org.id, userId: member.id }, () =>
      db.getUsageStats("24h", resolveUsageFilterUserId(member, USAGE_SCOPE_ALL)),
    );
    const orgWide = await runWithContext({ orgId: org.id, userId: admin.id }, () =>
      db.getUsageStats("24h", resolveUsageFilterUserId(admin, USAGE_SCOPE_ALL)),
    );

    expect(adminMine.totalPromptTokens).toBe(100);
    expect(adminMine.totalCompletionTokens).toBe(20);
    expect(adminMine.totalRequests).toBe(1);

    expect(memberMine.totalPromptTokens).toBe(7);
    expect(memberMine.totalCompletionTokens).toBe(3);
    expect(memberMine.totalRequests).toBe(1);
    expect(Object.values(memberMine.byModel).map((m) => m.rawModel)).toEqual(["gpt-4o-mini"]);

    expect(orgWide.totalPromptTokens).toBe(107);
    expect(orgWide.totalCompletionTokens).toBe(23);
    expect(orgWide.totalRequests).toBe(2);
  }, 20000);
});

import { spawn } from "node:child_process";
import { getAdapter } from "./driver.js";
import { TABLES } from "./schema.js";
import { qAll, qGet, qRun, qTransaction } from "./query.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";
import {
  SEALED_BACKUP_FORMAT,
  isSealedBackup,
  sealBackup,
  unsealBackup,
  attachBackupChecksum,
  verifyBackupChecksum,
} from "./backupCrypto.js";

const BACKUP_FORMAT = "ebrouter-backup-v2";
const TENANT_BACKUP_FORMAT = "ebrouter-backup-v3";
const TABLE_NAMES = Object.keys(TABLES);
const RESTORE_CONFIRM_TEXT = "RESTORE";
const HEAVY_TABLES = new Set(["usageHistory", "requestDetails", "auditLogs"]);
const HEAVY_ROW_CAP = 10_000;

export { RESTORE_CONFIRM_TEXT, HEAVY_ROW_CAP, TENANT_BACKUP_FORMAT, SEALED_BACKUP_FORMAT };

export function getDatabaseInfo() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    return {
      driver: "sqlite",
      display: "Local SQLite",
      exportFormat: "json",
      backupScope: "tenant",
    };
  }

  try {
    const normalized = url.replace(/^postgres:/, "postgresql:");
    const parsed = new URL(normalized);
    const host = parsed.hostname || "localhost";
    const port = parsed.port || "5432";
    const database = parsed.pathname?.replace(/^\//, "") || "ebrouter";
    return {
      driver: "postgres",
      display: `${host}:${port}/${database}`,
      exportFormat: "json",
      backupScope: "tenant",
    };
  } catch {
    return {
      driver: "postgres",
      display: "PostgreSQL",
      exportFormat: "json",
      backupScope: "tenant",
    };
  }
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteTable(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function quoteColumn(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function resolveBackupScope(actor) {
  if (!actor?.orgId || !actor?.id) {
    throw new Error("Authenticated user with organization is required for backup");
  }
  const isAdmin = actor.role === "admin";
  return {
    scope: isAdmin ? "org" : "user",
    orgId: actor.orgId,
    userId: actor.id,
    isAdmin,
  };
}

function orgKvPattern(orgId) {
  return `%:org:${orgId}:%`;
}

function userKvPattern(orgId, userId) {
  return `%:org:${orgId}:user:${userId}`;
}

async function selectByOrg(db, table, orgId) {
  return qAll(db, `SELECT * FROM ${quoteTable(table)} WHERE orgId = ?`, [orgId]);
}

async function selectByOrgAndUser(db, table, orgId, userId) {
  return qAll(
    db,
    `SELECT * FROM ${quoteTable(table)} WHERE orgId = ? AND userId = ?`,
    [orgId, userId]
  );
}

async function countByOrg(db, table, orgId) {
  const row = await qGet(db, `SELECT COUNT(*) AS c FROM ${quoteTable(table)} WHERE orgId = ?`, [orgId]);
  return Number(row?.c || 0);
}

async function countByOrgAndUser(db, table, orgId, userId) {
  const row = await qGet(
    db,
    `SELECT COUNT(*) AS c FROM ${quoteTable(table)} WHERE orgId = ? AND userId = ?`,
    [orgId, userId]
  );
  return Number(row?.c || 0);
}

async function selectHeavyByOrg(db, table, orgId, { includeHeavyData }) {
  if (!includeHeavyData) return [];
  return qAll(
    db,
    `SELECT * FROM ${quoteTable(table)} WHERE orgId = ? ORDER BY timestamp DESC LIMIT ?`,
    [orgId, HEAVY_ROW_CAP]
  );
}

async function selectHeavyByOrgAndUser(db, table, orgId, userId, { includeHeavyData }) {
  if (!includeHeavyData) return [];
  return qAll(
    db,
    `SELECT * FROM ${quoteTable(table)} WHERE orgId = ? AND userId = ? ORDER BY timestamp DESC LIMIT ?`,
    [orgId, userId, HEAVY_ROW_CAP]
  );
}

function rowCounts(tables) {
  const out = {};
  for (const [name, rows] of Object.entries(tables || {})) {
    out[name] = Array.isArray(rows) ? rows.length : 0;
  }
  return out;
}

async function exportOrgTables(db, orgId, options = {}) {
  const includeHeavyData = options.includeHeavyData === true;
  const users = await selectByOrg(db, "users", orgId);
  const userIds = users.map((u) => u.id);

  let userSettings = [];
  if (userIds.length) {
    const placeholders = userIds.map(() => "?").join(", ");
    userSettings = await qAll(
      db,
      `SELECT * FROM userSettings WHERE userId IN (${placeholders})`,
      userIds
    );
  }

  const heavyMeta = {};
  for (const table of HEAVY_TABLES) {
    const total = await countByOrg(db, table, orgId);
    heavyMeta[table] = {
      total,
      included: includeHeavyData ? Math.min(total, HEAVY_ROW_CAP) : 0,
      capped: includeHeavyData && total > HEAVY_ROW_CAP,
    };
  }

  return {
    tables: {
      organizations: await qAll(db, `SELECT * FROM organizations WHERE id = ?`, [orgId]),
      settings: await selectByOrg(db, "settings", orgId),
      users,
      userSettings,
      userInvites: await selectByOrg(db, "userInvites", orgId),
      providerConnections: await selectByOrg(db, "providerConnections", orgId),
      providerNodes: await selectByOrg(db, "providerNodes", orgId),
      proxyPools: await selectByOrg(db, "proxyPools", orgId),
      apiKeys: await selectByOrg(db, "apiKeys", orgId),
      combos: await selectByOrg(db, "combos", orgId),
      usageDaily: await selectByOrg(db, "usageDaily", orgId),
      usageHistory: await selectHeavyByOrg(db, "usageHistory", orgId, { includeHeavyData }),
      requestDetails: await selectHeavyByOrg(db, "requestDetails", orgId, { includeHeavyData }),
      auditLogs: await selectHeavyByOrg(db, "auditLogs", orgId, { includeHeavyData }),
      kv: await qAll(db, `SELECT * FROM kv WHERE scope LIKE ?`, [orgKvPattern(orgId)]),
    },
    heavyMeta,
  };
}

async function exportUserTables(db, orgId, userId, options = {}) {
  const includeHeavyData = options.includeHeavyData === true;
  const heavyMeta = {};
  for (const table of ["usageHistory", "requestDetails"]) {
    const total = await countByOrgAndUser(db, table, orgId, userId);
    heavyMeta[table] = {
      total,
      included: includeHeavyData ? Math.min(total, HEAVY_ROW_CAP) : 0,
      capped: includeHeavyData && total > HEAVY_ROW_CAP,
    };
  }

  return {
    tables: {
      userSettings: await qAll(db, `SELECT * FROM userSettings WHERE userId = ?`, [userId]),
      providerConnections: await selectByOrgAndUser(db, "providerConnections", orgId, userId),
      apiKeys: await selectByOrgAndUser(db, "apiKeys", orgId, userId),
      combos: await selectByOrgAndUser(db, "combos", orgId, userId),
      usageHistory: await selectHeavyByOrgAndUser(db, "usageHistory", orgId, userId, { includeHeavyData }),
      requestDetails: await selectHeavyByOrgAndUser(db, "requestDetails", orgId, userId, { includeHeavyData }),
      kv: await qAll(db, `SELECT * FROM kv WHERE scope LIKE ?`, [userKvPattern(orgId, userId)]),
    },
    heavyMeta,
  };
}

export async function exportTenantBackup(actor, options = {}) {
  const { scope, orgId, userId } = resolveBackupScope(actor);
  const db = await getAdapter();
  const exported = scope === "org"
    ? await exportOrgTables(db, orgId, options)
    : await exportUserTables(db, orgId, userId, options);

  const payload = {
    format: TENANT_BACKUP_FORMAT,
    scope,
    orgId,
    userId: scope === "user" ? userId : undefined,
    dialect: db.dialect,
    exportedAt: new Date().toISOString(),
    includeHeavyData: options.includeHeavyData === true,
    heavyMeta: exported.heavyMeta,
    tables: exported.tables,
  };
  return attachBackupChecksum(payload);
}

async function insertRows(tx, tableName, rows) {
  for (const row of rows || []) {
    const columns = Object.keys(row);
    if (!columns.length) continue;
    const colSql = columns.map(quoteColumn).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    await qRun(
      tx,
      `INSERT INTO ${quoteTable(tableName)} (${colSql}) VALUES (${placeholders})`,
      columns.map((c) => row[c])
    );
  }
}

async function deleteOrgSlice(tx, orgId) {
  const userRows = await qAll(tx, `SELECT id FROM users WHERE orgId = ?`, [orgId]);
  const userIds = userRows.map((u) => u.id);

  await qRun(tx, `DELETE FROM auditLogs WHERE orgId = ?`, [orgId]);
  await qRun(tx, `DELETE FROM requestDetails WHERE orgId = ?`, [orgId]);
  await qRun(tx, `DELETE FROM usageHistory WHERE orgId = ?`, [orgId]);
  await qRun(tx, `DELETE FROM usageDaily WHERE orgId = ?`, [orgId]);
  await qRun(tx, `DELETE FROM providerConnections WHERE orgId = ?`, [orgId]);
  await qRun(tx, `DELETE FROM providerNodes WHERE orgId = ?`, [orgId]);
  await qRun(tx, `DELETE FROM proxyPools WHERE orgId = ?`, [orgId]);
  await qRun(tx, `DELETE FROM apiKeys WHERE orgId = ?`, [orgId]);
  await qRun(tx, `DELETE FROM combos WHERE orgId = ?`, [orgId]);
  await qRun(tx, `DELETE FROM userInvites WHERE orgId = ?`, [orgId]);
  await qRun(tx, `DELETE FROM settings WHERE orgId = ?`, [orgId]);
  await qRun(tx, `DELETE FROM kv WHERE scope LIKE ?`, [orgKvPattern(orgId)]);

  if (userIds.length) {
    const placeholders = userIds.map(() => "?").join(", ");
    await qRun(tx, `DELETE FROM passwordResetTokens WHERE userId IN (${placeholders})`, userIds);
    await qRun(tx, `DELETE FROM userSettings WHERE userId IN (${placeholders})`, userIds);
  }

  await qRun(tx, `DELETE FROM users WHERE orgId = ?`, [orgId]);
}

async function deleteUserSlice(tx, orgId, userId) {
  await qRun(tx, `DELETE FROM requestDetails WHERE orgId = ? AND userId = ?`, [orgId, userId]);
  await qRun(tx, `DELETE FROM usageHistory WHERE orgId = ? AND userId = ?`, [orgId, userId]);
  await qRun(tx, `DELETE FROM providerConnections WHERE orgId = ? AND userId = ?`, [orgId, userId]);
  await qRun(tx, `DELETE FROM apiKeys WHERE orgId = ? AND userId = ?`, [orgId, userId]);
  await qRun(tx, `DELETE FROM combos WHERE orgId = ? AND userId = ?`, [orgId, userId]);
  await qRun(tx, `DELETE FROM passwordResetTokens WHERE userId = ?`, [userId]);
  await qRun(tx, `DELETE FROM userSettings WHERE userId = ?`, [userId]);
  await qRun(tx, `DELETE FROM kv WHERE scope LIKE ?`, [userKvPattern(orgId, userId)]);
}

function assertTenantPayload(payload, actor) {
  if (!payload || payload.format !== TENANT_BACKUP_FORMAT || !payload.tables) {
    throw new Error("Invalid tenant backup. Use a backup downloaded from this organization's Profile page.");
  }
  verifyBackupChecksum(payload);
  if (!actor?.orgId || !actor?.id) {
    throw new Error("Authenticated user with organization is required to import backup");
  }
  if (payload.orgId !== actor.orgId) {
    throw new Error("Backup belongs to a different organization");
  }

  const isAdmin = actor.role === "admin";
  if (payload.scope === "org") {
    if (!isAdmin) {
      throw new Error("Only organization admins can import an organization backup");
    }
    return { scope: "org", orgId: actor.orgId };
  }

  if (payload.scope === "user") {
    if (!payload.userId) {
      throw new Error("User backup is missing userId");
    }
    if (!isAdmin && payload.userId !== actor.id) {
      throw new Error("Backup belongs to a different user");
    }
    return { scope: "user", orgId: actor.orgId, userId: payload.userId };
  }

  throw new Error("Unsupported backup scope");
}

async function importOrgBackup(tx, orgId, tables) {
  await deleteOrgSlice(tx, orgId);

  const orgRow = (tables.organizations || []).find((r) => r.id === orgId) || (tables.organizations || [])[0];
  if (orgRow) {
    await qRun(
      tx,
      `INSERT INTO organizations(id, slug, name, status, plan, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         slug = excluded.slug,
         name = excluded.name,
         status = excluded.status,
         plan = excluded.plan,
         updatedAt = excluded.updatedAt`,
      [
        orgId,
        orgRow.slug,
        orgRow.name,
        orgRow.status || "active",
        orgRow.plan || "free",
        orgRow.createdAt || new Date().toISOString(),
        orgRow.updatedAt || new Date().toISOString(),
      ]
    );
  }

  await insertRows(tx, "settings", (tables.settings || []).map((r) => ({ ...r, orgId })));
  await insertRows(tx, "users", (tables.users || []).map((r) => ({ ...r, orgId })));
  await insertRows(tx, "userSettings", tables.userSettings);
  await insertRows(tx, "userInvites", (tables.userInvites || []).map((r) => ({ ...r, orgId })));
  await insertRows(tx, "providerConnections", (tables.providerConnections || []).map((r) => ({ ...r, orgId })));
  await insertRows(tx, "providerNodes", (tables.providerNodes || []).map((r) => ({ ...r, orgId })));
  await insertRows(tx, "proxyPools", (tables.proxyPools || []).map((r) => ({ ...r, orgId })));
  await insertRows(tx, "apiKeys", (tables.apiKeys || []).map((r) => ({ ...r, orgId })));
  await insertRows(tx, "combos", (tables.combos || []).map((r) => ({ ...r, orgId })));
  await insertRows(tx, "usageHistory", (tables.usageHistory || []).map((r) => ({ ...r, orgId })));
  await insertRows(tx, "usageDaily", (tables.usageDaily || []).map((r) => ({ ...r, orgId })));
  await insertRows(tx, "requestDetails", (tables.requestDetails || []).map((r) => ({ ...r, orgId })));
  await insertRows(tx, "auditLogs", (tables.auditLogs || []).map((r) => ({ ...r, orgId })));
  await insertRows(tx, "kv", tables.kv);
}

async function importUserBackup(tx, orgId, userId, tables) {
  await deleteUserSlice(tx, orgId, userId);
  await insertRows(tx, "userSettings", (tables.userSettings || []).map((r) => ({ ...r, userId })));
  await insertRows(
    tx,
    "providerConnections",
    (tables.providerConnections || []).map((r) => ({ ...r, orgId, userId }))
  );
  await insertRows(tx, "apiKeys", (tables.apiKeys || []).map((r) => ({ ...r, orgId, userId })));
  await insertRows(tx, "combos", (tables.combos || []).map((r) => ({ ...r, orgId, userId })));
  await insertRows(tx, "usageHistory", (tables.usageHistory || []).map((r) => ({ ...r, orgId, userId })));
  await insertRows(tx, "requestDetails", (tables.requestDetails || []).map((r) => ({ ...r, orgId, userId })));
  await insertRows(tx, "kv", tables.kv);
}

async function currentSliceCounts(db, target) {
  if (target.scope === "org") {
    const orgId = target.orgId;
    const users = await countByOrg(db, "users", orgId);
    return {
      users,
      userSettings: users, // approximate; exact not needed for preview
      userInvites: await countByOrg(db, "userInvites", orgId),
      providerConnections: await countByOrg(db, "providerConnections", orgId),
      providerNodes: await countByOrg(db, "providerNodes", orgId),
      proxyPools: await countByOrg(db, "proxyPools", orgId),
      apiKeys: await countByOrg(db, "apiKeys", orgId),
      combos: await countByOrg(db, "combos", orgId),
      usageDaily: await countByOrg(db, "usageDaily", orgId),
      usageHistory: await countByOrg(db, "usageHistory", orgId),
      requestDetails: await countByOrg(db, "requestDetails", orgId),
      auditLogs: await countByOrg(db, "auditLogs", orgId),
    };
  }

  const { orgId, userId } = target;
  return {
    userSettings: Number((await qGet(db, `SELECT COUNT(*) AS c FROM userSettings WHERE userId = ?`, [userId]))?.c || 0),
    providerConnections: await countByOrgAndUser(db, "providerConnections", orgId, userId),
    apiKeys: await countByOrgAndUser(db, "apiKeys", orgId, userId),
    combos: await countByOrgAndUser(db, "combos", orgId, userId),
    usageHistory: await countByOrgAndUser(db, "usageHistory", orgId, userId),
    requestDetails: await countByOrgAndUser(db, "requestDetails", orgId, userId),
  };
}

function buildRestoreWarnings(payload, actor, target) {
  const warnings = [];
  if (target.scope === "org") {
    warnings.push("This will permanently replace all data for your organization with the backup.");
    const backupUserIds = new Set((payload.tables.users || []).map((u) => u.id));
    if (!backupUserIds.has(actor.id)) {
      warnings.push("Your admin account is not in this backup — restoring may lock you out.");
    }
    if (!(payload.tables.users || []).some((u) => u.role === "admin")) {
      warnings.push("Backup contains no admin users.");
    }
  } else {
    warnings.push("This will permanently replace your personal connections, keys, combos, and related data.");
  }
  if (!payload.includeHeavyData) {
    warnings.push("Heavy history tables (usage details / request logs / audit) were not included in this backup.");
  }
  for (const [table, meta] of Object.entries(payload.heavyMeta || {})) {
    if (meta?.capped) {
      warnings.push(`${table} was capped at ${HEAVY_ROW_CAP} newest rows during export.`);
    }
  }
  return warnings;
}

export async function previewTenantBackup(payload, actor) {
  const target = assertTenantPayload(payload, actor);
  const db = await getAdapter();

  if (target.scope === "user") {
    const member = await qGet(db, `SELECT id FROM users WHERE id = ? AND orgId = ?`, [
      target.userId,
      target.orgId,
    ]);
    if (!member) {
      throw new Error("Backup user is not a member of this organization");
    }
  }

  const willDelete = await currentSliceCounts(db, target);
  const willInsert = rowCounts(payload.tables);

  return {
    dryRun: true,
    scope: target.scope,
    orgId: target.orgId,
    userId: target.userId || null,
    willDelete,
    willInsert,
    warnings: buildRestoreWarnings(payload, actor, target),
    confirmTextRequired: RESTORE_CONFIRM_TEXT,
  };
}

export async function importTenantBackup(payload, actor, options = {}) {
  if (options.dryRun) {
    return previewTenantBackup(payload, actor);
  }

  if (options.confirmText !== RESTORE_CONFIRM_TEXT) {
    throw new Error(`Type ${RESTORE_CONFIRM_TEXT} to confirm this destructive restore`);
  }

  const target = assertTenantPayload(payload, actor);
  const db = await getAdapter();

  if (target.scope === "user") {
    const member = await qGet(db, `SELECT id FROM users WHERE id = ? AND orgId = ?`, [
      target.userId,
      target.orgId,
    ]);
    if (!member) {
      throw new Error("Backup user is not a member of this organization");
    }
  }

  await qTransaction(db, async (tx) => {
    if (target.scope === "org") {
      await importOrgBackup(tx, target.orgId, payload.tables);
      return;
    }
    await importUserBackup(tx, target.orgId, target.userId, payload.tables);
  });

  return { success: true, scope: target.scope, orgId: target.orgId, userId: target.userId || null };
}

export async function resolveTenantBackupInput(input, passphrase) {
  if (isSealedBackup(input)) {
    return unsealBackup(input, passphrase);
  }
  if (input?.format === TENANT_BACKUP_FORMAT && input.tables) {
    // Plaintext v3 allowed only for internal/tests; Profile API always seals.
    verifyBackupChecksum(input);
    return input;
  }
  throw new Error("Invalid tenant backup. Expected an encrypted Profile backup file.");
}

async function pgDumpViaCli(connectionString) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "pg_dump",
      [connectionString, "--clean", "--if-exists", "--no-owner", "--no-acl"],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `pg_dump exited with code ${code}`));
    });
  });
}

/** Full-instance SQL dump for ops/scripts — not used by the Profile UI. */
export async function exportPostgresSql() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured");
  }

  try {
    const dumped = await pgDumpViaCli(connectionString);
    return dumped;
  } catch (cliError) {
    console.warn("[DB][backup] pg_dump unavailable, using in-app SQL export:", cliError.message);
  }

  const db = await getAdapter();
  if (db.dialect !== "postgres") {
    throw new Error("PostgreSQL backup requires a PostgreSQL database");
  }

  const lines = [
    "-- ebRouter PostgreSQL backup",
    `-- Generated: ${new Date().toISOString()}`,
    "BEGIN;",
    "SET session_replication_role = replica;",
  ];

  for (const tableName of TABLE_NAMES) {
    const rows = await qAll(db, `SELECT * FROM ${quoteTable(tableName)}`);
    if (!rows.length) continue;

    lines.push("");
    lines.push(`-- Table: ${tableName}`);
    lines.push(`DELETE FROM ${quoteTable(tableName)};`);

    for (const row of rows) {
      const columns = Object.keys(row).map(quoteColumn).join(", ");
      const values = Object.values(row).map(sqlLiteral).join(", ");
      lines.push(`INSERT INTO ${quoteTable(tableName)} (${columns}) VALUES (${values});`);
    }
  }

  lines.push("SET session_replication_role = DEFAULT;");
  lines.push("COMMIT;");
  lines.push("");
  return lines.join("\n");
}

export async function exportFullDbJson() {
  const db = await getAdapter();
  const tables = {};

  for (const tableName of TABLE_NAMES) {
    tables[tableName] = await qAll(db, `SELECT * FROM ${quoteTable(tableName)}`);
  }

  return {
    format: BACKUP_FORMAT,
    dialect: db.dialect,
    exportedAt: new Date().toISOString(),
    tables,
  };
}

export async function createBackupDownload(actor, options = {}) {
  const { passphrase, includeHeavyData = false } = options;
  if (!passphrase) {
    throw new Error("A backup passphrase is required to download an encrypted backup");
  }

  const payload = await exportTenantBackup(actor, { includeHeavyData });
  const sealed = await sealBackup(payload, passphrase, {
    includeHeavyData: payload.includeHeavyData,
    heavyMeta: payload.heavyMeta,
    rowCounts: rowCounts(payload.tables),
  });

  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const label = payload.scope === "org" ? "org" : "user";
  return {
    content: JSON.stringify(sealed, null, 2),
    filename: `ebrouter-${label}-backup-${stamp}.json`,
    contentType: "application/json; charset=utf-8",
    format: "json",
    scope: payload.scope,
    sealed: true,
    meta: sealed.meta,
  };
}

export async function exportLegacyDbJson() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    settings: await exportSettings(),
    providerConnections: (await qAll(db, `SELECT * FROM providerConnections`)).map((r) => ({
      ...parseJson(r.data, {}),
      id: r.id,
      provider: r.provider,
      authType: r.authType,
      name: r.name,
      email: r.email,
      priority: r.priority,
      isActive: r.isActive === 1 || r.isActive === true,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    providerNodes: (await qAll(db, `SELECT * FROM providerNodes`)).map((r) => ({
      ...parseJson(r.data, {}),
      id: r.id,
      type: r.type,
      name: r.name,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    proxyPools: (await qAll(db, `SELECT * FROM proxyPools`)).map((r) => ({
      ...parseJson(r.data, {}),
      id: r.id,
      isActive: r.isActive === 1 || r.isActive === true,
      testStatus: r.testStatus,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    apiKeys: (await qAll(db, `SELECT * FROM apiKeys`)).map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      machineId: r.machineId,
      isActive: r.isActive === 1 || r.isActive === true,
      createdAt: r.createdAt,
    })),
    combos: (await qAll(db, `SELECT * FROM combos`)).map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      models: parseJson(r.models, []),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
  };

  for (const r of await qAll(db, `SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) {
    out.modelAliases[r.key] = parseJson(r.value);
  }
  for (const r of await qAll(db, `SELECT key, value FROM kv WHERE scope = 'customModels'`)) {
    out.customModels.push(parseJson(r.value));
  }
  for (const r of await qAll(db, `SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) {
    out.mitmAlias[r.key] = parseJson(r.value);
  }
  for (const r of await qAll(db, `SELECT key, value FROM kv WHERE scope = 'pricing'`)) {
    out.pricing[r.key] = parseJson(r.value);
  }

  return out;
}

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("--"));
}

async function restorePostgresSqlViaCli(connectionString, sqlText) {
  return new Promise((resolve, reject) => {
    const proc = spawn("psql", [connectionString, "-v", "ON_ERROR_STOP=1"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `psql exited with code ${code}`));
    });
    proc.stdin.write(sqlText);
    proc.stdin.end();
  });
}

async function importPostgresSql(sqlText) {
  const db = await getAdapter();
  if (db.dialect !== "postgres") {
    throw new Error("SQL restore requires PostgreSQL");
  }

  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString) {
    try {
      await restorePostgresSqlViaCli(connectionString, sqlText);
      return;
    } catch (cliError) {
      console.warn("[DB][backup] psql restore unavailable, using in-app SQL import:", cliError.message);
    }
  }

  const statements = splitSqlStatements(sqlText);
  if (!statements.length) {
    throw new Error("Backup SQL file is empty");
  }

  await qTransaction(db, async (tx) => {
    for (const statement of statements) {
      await qRun(tx, statement);
    }
  });
}

async function importFullDbJson(payload) {
  const db = await getAdapter();
  const tables = payload.tables || {};

  await qTransaction(db, async (tx) => {
    if (db.dialect === "postgres") {
      const tableList = TABLE_NAMES.map(quoteTable).join(", ");
      await qRun(tx, `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    } else {
      for (const tableName of [...TABLE_NAMES].reverse()) {
        await qRun(tx, `DELETE FROM ${quoteTable(tableName)}`);
      }
    }

    for (const tableName of TABLE_NAMES) {
      const rows = tables[tableName] || [];
      for (const row of rows) {
        const columns = Object.keys(row).map(quoteColumn).join(", ");
        const placeholders = Object.keys(row).map(() => "?").join(", ");
        await qRun(
          tx,
          `INSERT INTO ${quoteTable(tableName)} (${columns}) VALUES (${placeholders})`,
          Object.values(row)
        );
      }
    }
  });
}

async function importLegacyDbJson(payload) {
  const db = await getAdapter();

  await qTransaction(db, async (tx) => {
    await qRun(tx, `DELETE FROM settings`);
    await qRun(tx, `DELETE FROM providerConnections`);
    await qRun(tx, `DELETE FROM providerNodes`);
    await qRun(tx, `DELETE FROM proxyPools`);
    await qRun(tx, `DELETE FROM apiKeys`);
    await qRun(tx, `DELETE FROM combos`);
    await qRun(tx, `DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing')`);

    if (payload.settings) {
      const { getDefaultOrgId } = await import("./repos/organizationsRepo.js");
      const orgId = (await getDefaultOrgId()) || "legacy";
      await qRun(
        tx,
        `INSERT INTO settings(orgId, data) VALUES(?, ?) ON CONFLICT(orgId) DO UPDATE SET data = excluded.data`,
        [orgId, stringifyJson(payload.settings)],
      );
    }

    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      await qRun(
        tx,
        `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           authType = excluded.authType,
           name = excluded.name,
           email = excluded.email,
           priority = excluded.priority,
           isActive = excluded.isActive,
           data = excluded.data,
           createdAt = excluded.createdAt,
           updatedAt = excluded.updatedAt`,
        [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }

    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      await qRun(
        tx,
        `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           name = excluded.name,
           data = excluded.data,
           createdAt = excluded.createdAt,
           updatedAt = excluded.updatedAt`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }

    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      await qRun(
        tx,
        `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           isActive = excluded.isActive,
           testStatus = excluded.testStatus,
           data = excluded.data,
           createdAt = excluded.createdAt,
           updatedAt = excluded.updatedAt`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }

    for (const k of payload.apiKeys || []) {
      await qRun(
        tx,
        `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           key = excluded.key,
           name = excluded.name,
           machineId = excluded.machineId,
           isActive = excluded.isActive,
           createdAt = excluded.createdAt`,
        [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString()]
      );
    }

    for (const c of payload.combos || []) {
      await qRun(
        tx,
        `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           models = excluded.models,
           createdAt = excluded.createdAt,
           updatedAt = excluded.updatedAt`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }

    for (const [alias, model] of Object.entries(payload.modelAliases || {})) {
      await qRun(
        tx,
        `INSERT INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [alias, stringifyJson(model)]
      );
    }

    for (const m of payload.customModels || []) {
      const key = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      await qRun(
        tx,
        `INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [key, stringifyJson(m)]
      );
    }

    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      await qRun(
        tx,
        `INSERT INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [tool, stringifyJson(mappings || {})]
      );
    }

    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      await qRun(
        tx,
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(models || {})]
      );
    }
  });
}

/**
 * Import backup.
 * - With `actor` (Profile UI): sealed tenant backup + confirmText; optional dryRun.
 * - Without `actor` (tests / internal): legacy + full-DB formats still supported.
 */
export async function importBackup(input, actor = null, options = {}) {
  if (actor) {
    if (typeof input === "string") {
      throw new Error("Full SQL backups are not supported. Download a tenant backup from Profile instead.");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid database backup");
    }
    if (input.format === BACKUP_FORMAT) {
      throw new Error("Full-database backups are not supported. Use an organization or user backup from Profile.");
    }

    const passphrase = options.passphrase;
    const payload = await resolveTenantBackupInput(input, passphrase);
    return importTenantBackup(payload, actor, {
      dryRun: options.dryRun === true,
      confirmText: options.confirmText,
    });
  }

  if (typeof input === "string") {
    await importPostgresSql(input);
    return;
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid database backup");
  }

  if (input.format === TENANT_BACKUP_FORMAT && input.tables) {
    throw new Error("Tenant backup requires an authenticated import context");
  }

  if (isSealedBackup(input)) {
    throw new Error("Sealed tenant backup requires an authenticated import context");
  }

  if (input.format === BACKUP_FORMAT && input.tables) {
    await importFullDbJson(input);
    return;
  }

  await importLegacyDbJson(input);
}

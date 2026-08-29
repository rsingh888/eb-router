import crypto from "node:crypto";
import { isSaas } from "../deploy/deployMode.js";

function hashBucket(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 40);
}

function windowId(scope, bucketKey, windowStart) {
  return `${scope}:${bucketKey}:${windowStart}`;
}

async function getDb() {
  try {
    const { getAdapter } = await import("../db/driver.js");
    return await getAdapter();
  } catch {
    return null;
  }
}

function useSharedStore(db) {
  return !!(db && (isSaas() || process.env.DATABASE_URL));
}

/**
 * Sliding-ish fixed window counter. Shared across replicas when Postgres is available.
 * Falls back to in-memory maps for single-process on-prem.
 */
const memoryWindows = new Map();

export async function consumeRateLimit({ scope, key, windowMs, limit }) {
  const now = Date.now();
  const windowStart = String(Math.floor(now / windowMs) * windowMs);
  const bucketKey = hashBucket(key || "unknown");
  const id = windowId(scope, bucketKey, windowStart);

  const db = await getDb();
  if (useSharedStore(db)) {
    try {
      const { qRun, qGet } = await import("../db/query.js");
      const incSql = db.dialect === "postgres"
        ? `INSERT INTO "rateLimitWindows"(id, scope, "bucketKey", "windowStart", count) VALUES(?, ?, ?, ?, 1)
           ON CONFLICT(id) DO UPDATE SET count = "rateLimitWindows".count + 1`
        : `INSERT INTO rateLimitWindows(id, scope, bucketKey, windowStart, count) VALUES(?, ?, ?, ?, 1)
           ON CONFLICT(id) DO UPDATE SET count = count + 1`;
      await qRun(db, incSql, [id, scope, bucketKey, windowStart, 1]);
      const row = db.dialect === "postgres"
        ? await qGet(db, `SELECT count FROM "rateLimitWindows" WHERE id = ?`, [id])
        : await qGet(db, `SELECT count FROM rateLimitWindows WHERE id = ?`, [id]);
      const count = Number(row?.count || 0);
      if (count > limit) {
        const retryAfter = Math.max(1, Math.ceil((Number(windowStart) + windowMs - now) / 1000));
        return { allowed: false, retryAfter, remaining: 0 };
      }
      return { allowed: true, retryAfter: 0, remaining: Math.max(0, limit - count) };
    } catch (err) {
      console.warn("[rate-limit] shared store failed, using memory:", err.message);
    }
  }

  const memKey = `${scope}:${bucketKey}:${windowStart}`;
  const count = (memoryWindows.get(memKey) || 0) + 1;
  memoryWindows.set(memKey, count);
  if (memoryWindows.size > 5000) {
    const cutoff = String(now - windowMs * 2);
    for (const k of memoryWindows.keys()) {
      const start = k.split(":").pop();
      if (start && start < cutoff) memoryWindows.delete(k);
    }
  }
  if (count > limit) {
    const retryAfter = Math.max(1, Math.ceil((Number(windowStart) + windowMs - now) / 1000));
    return { allowed: false, retryAfter, remaining: 0 };
  }
  return { allowed: true, retryAfter: 0, remaining: Math.max(0, limit - count) };
}

export async function readLoginLockout(ip) {
  const db = await getDb();
  if (useSharedStore(db)) {
    try {
      const { qGet } = await import("../db/query.js");
      const table = db.dialect === "postgres" ? `"loginLockouts"` : "loginLockouts";
      const row = await qGet(db, `SELECT * FROM ${table} WHERE ip = ?`, [ip]);
      if (!row) return null;
      return {
        fails: Number(row.fails || 0),
        lockUntil: Number(row.lockUntil || 0),
        lockLevel: Number(row.lockLevel || 0),
        lastFailAt: Number(row.lastFailAt || 0),
      };
    } catch (err) {
      console.warn("[rate-limit] login lockout read failed:", err.message);
    }
  }
  return null;
}

export async function writeLoginLockout(ip, entry) {
  const db = await getDb();
  if (useSharedStore(db)) {
    try {
      const { qRun } = await import("../db/query.js");
      const sql = db.dialect === "postgres"
        ? `INSERT INTO "loginLockouts"(ip, fails, "lockUntil", "lockLevel", "lastFailAt") VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(ip) DO UPDATE SET
             fails = excluded.fails,
             "lockUntil" = excluded."lockUntil",
             "lockLevel" = excluded."lockLevel",
             "lastFailAt" = excluded."lastFailAt"`
        : `INSERT INTO loginLockouts(ip, fails, lockUntil, lockLevel, lastFailAt) VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(ip) DO UPDATE SET
             fails = excluded.fails,
             lockUntil = excluded.lockUntil,
             lockLevel = excluded.lockLevel,
             lastFailAt = excluded.lastFailAt`;
      await qRun(db, sql, [ip, entry.fails, entry.lockUntil, entry.lockLevel, entry.lastFailAt]);
      return;
    } catch (err) {
      console.warn("[rate-limit] login lockout write failed:", err.message);
    }
  }
}

export async function deleteLoginLockout(ip) {
  const db = await getDb();
  if (useSharedStore(db)) {
    try {
      const { qRun } = await import("../db/query.js");
      const table = db.dialect === "postgres" ? `"loginLockouts"` : "loginLockouts";
      await qRun(db, `DELETE FROM ${table} WHERE ip = ?`, [ip]);
    } catch (err) {
      console.warn("[rate-limit] login lockout delete failed:", err.message);
    }
  }
}

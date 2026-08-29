// Progressive lockout for dashboard login. Shared across replicas when Postgres is available.

import { deleteLoginLockout, readLoginLockout, writeLoginLockout } from "./sharedRateLimit.js";

const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m
const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1h since last fail → auto reset

const attempts = new Map(); // ip → { fails, lockUntil, lockLevel, lastFailAt }

function now() { return Date.now(); }

function expired(e) {
  return e.lastFailAt && now() - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || now() >= e.lockUntil);
}

async function getEntry(ip) {
  let e = attempts.get(ip);
  if (!e) {
    e = await readLoginLockout(ip);
    if (e) attempts.set(ip, e);
  }
  if (!e) return null;
  if (expired(e)) {
    attempts.delete(ip);
    await deleteLoginLockout(ip);
    return null;
  }
  return e;
}

export async function checkLock(ip) {
  const e = await getEntry(ip);
  if (!e || !e.lockUntil) return { locked: false };
  const remaining = e.lockUntil - now();
  if (remaining <= 0) return { locked: false };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

export async function recordFail(ip) {
  const e = (await getEntry(ip)) || { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 };
  e.fails += 1;
  e.lastFailAt = now();
  if (e.fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = LOCK_STEPS_MS[Math.min(e.lockLevel, LOCK_STEPS_MS.length - 1)];
    e.lockUntil = now() + step;
    e.lockLevel += 1;
    e.fails = 0;
  }
  attempts.set(ip, e);
  await writeLoginLockout(ip, e);
  return { remainingBeforeLock: Math.max(0, MAX_FAILS_BEFORE_LOCK - e.fails) };
}

export async function recordSuccess(ip) {
  attempts.delete(ip);
  await deleteLoginLockout(ip);
}

export function getClientIp(request) {
  // Trusted: set from TCP socket by custom-server.js (client cannot spoof).
  const realIp = request.headers.get("x-9r-real-ip");
  if (realIp) return realIp;
  // Behind a trusted reverse proxy that overwrites XFF with the real client IP.
  if (process.env.TRUST_PROXY === "true") {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  // Direct exposure without custom-server: single bucket so spoofed XFF
  // rotation cannot escape the limiter.
  return "unknown";
}

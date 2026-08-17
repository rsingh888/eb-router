import crypto from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(crypto.scrypt);

export const SEALED_BACKUP_FORMAT = "ebrouter-backup-v3-sealed";
export const MIN_BACKUP_PASSPHRASE_LENGTH = 12;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const NONCE_LEN = 12;

export function assertBackupPassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
    throw new Error(`Backup passphrase must be at least ${MIN_BACKUP_PASSPHRASE_LENGTH} characters`);
  }
}

export function isSealedBackup(value) {
  return value && typeof value === "object" && value.format === SEALED_BACKUP_FORMAT;
}

export function computeBackupChecksum(payload) {
  const body = {
    format: payload.format,
    scope: payload.scope,
    orgId: payload.orgId,
    userId: payload.userId ?? null,
    exportedAt: payload.exportedAt ?? null,
    tables: payload.tables,
  };
  return crypto.createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}

export function attachBackupChecksum(payload) {
  const next = { ...payload };
  delete next.checksum;
  next.checksum = computeBackupChecksum(next);
  return next;
}

export function verifyBackupChecksum(payload) {
  if (!payload?.checksum || typeof payload.checksum !== "string") {
    throw new Error("Backup integrity check failed: missing checksum");
  }
  const expected = payload.checksum;
  const actual = computeBackupChecksum(payload);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Backup integrity check failed: checksum mismatch (file may be tampered)");
  }
}

async function deriveKey(passphrase, salt) {
  return scryptAsync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
}

/**
 * Seal a tenant backup with a user passphrase (scrypt + AES-256-GCM).
 * Public meta never includes table contents or secrets.
 */
export async function sealBackup(payload, passphrase, publicMeta = {}) {
  assertBackupPassphrase(passphrase);
  const withChecksum = attachBackupChecksum(payload);
  const plaintext = Buffer.from(JSON.stringify(withChecksum), "utf8");

  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const key = await deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    format: SEALED_BACKUP_FORMAT,
    kdf: "scrypt",
    kdfParams: {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt: salt.toString("base64"),
    },
    cipher: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    meta: {
      scope: payload.scope,
      orgId: payload.orgId,
      userId: payload.userId || null,
      exportedAt: payload.exportedAt,
      ...publicMeta,
    },
  };
}

export async function unsealBackup(sealed, passphrase) {
  if (!isSealedBackup(sealed)) {
    throw new Error("Not an encrypted tenant backup");
  }
  assertBackupPassphrase(passphrase);

  const salt = Buffer.from(sealed.kdfParams?.salt || "", "base64");
  const nonce = Buffer.from(sealed.nonce || "", "base64");
  const tag = Buffer.from(sealed.tag || "", "base64");
  const ciphertext = Buffer.from(sealed.ciphertext || "", "base64");

  if (salt.length < 16 || nonce.length !== NONCE_LEN || tag.length !== 16 || !ciphertext.length) {
    throw new Error("Encrypted backup is malformed");
  }

  const key = await deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);

  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Wrong passphrase or backup file is corrupted");
  }

  let payload;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    throw new Error("Encrypted backup payload is invalid JSON");
  }

  verifyBackupChecksum(payload);
  return payload;
}

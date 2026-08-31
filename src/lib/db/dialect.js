// SQL dialect helpers — SQLite (default) vs PostgreSQL (DATABASE_URL).

const CAMEL_TABLES = [
  "_meta", "settings", "users", "userSettings", "userInvites", "passwordResetTokens",
  "providerConnections", "providerNodes", "proxyPools",
  "apiKeys", "combos", "kv", "usageHistory", "usageDaily", "requestDetails", "auditLogs",
];

const CAMEL_COLUMNS = [
  "authType", "isActive", "createdAt", "updatedAt", "machineId", "keyHash",
  "dateKey", "testStatus", "connectionId", "promptTokens", "completionTokens",
  "displayName", "globalPriority", "defaultModel", "accessToken", "refreshToken",
  "expiresAt", "tokenType", "projectId", "apiKey", "lastTested", "lastError",
  "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode", "consecutiveUseCount",
  "passwordHash", "oidcSub", "userId", "tokenHash", "createdBy", "usedAt",
  "mfaEnabled", "mfaSecret", "actorUserId", "actorEmail", "targetType", "targetId",
  "orgId",
  // Reserved-word column names (unquoted `key` breaks INSERT on Postgres)
  "key",
];

function quotePgIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** True for identifiers like createdAt, oidcSub, userSettings. */
function isCamelCaseIdent(name) {
  return /^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/.test(name);
}

function shouldQuotePgIdent(name, knownIdents) {
  // Known columns/tables win so `key` is quoted as a column, while `KEY` in
  // `PRIMARY KEY` stays unquoted syntax.
  if (knownIdents.has(name) || isCamelCaseIdent(name)) return true;
  return false;
}

/** Quote camelCase tables/columns for PostgreSQL (skips already-quoted idents). */
export function quotePgSql(sql) {
  const knownIdents = new Set([...CAMEL_TABLES, ...CAMEL_COLUMNS]);
  // Split on SQL string literals and double-quoted idents so we never quote inside '...' or "...".
  const parts = sql.split(/('(?:''|[^'])*'|"(?:[^"]|"")*")/g);
  return parts.map((part) => {
    if (part.startsWith("'") || part.startsWith('"')) return part;
    return part.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g, (match) => (
      shouldQuotePgIdent(match, knownIdents) ? quotePgIdent(match) : match
    ));
  }).join("");
}

/** Convert SQLite ? placeholders to PostgreSQL $1, $2, … */
export function toPgParams(sql, params = []) {
  let i = 0;
  const q = sql.replace(/\?/g, () => `$${++i}`);
  return { sql: quotePgSql(q), params };
}

export function isPostgresDialect(dialect) {
  return dialect === "postgres";
}

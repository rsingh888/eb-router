/** Deployment mode: multi-tenant SaaS vs single-org on-premise. */

function readEnv(name) {
  // Dynamic key so Next/webpack cannot inline the value at `next build` time.
  // `next start` then honors .env DEPLOY_MODE without a rebuild.
  if (typeof process === "undefined" || !process.env) return "";
  return process.env[name];
}

export function getDeployMode() {
  const mode = String(readEnv("DEPLOY_MODE") || "onprem").trim().toLowerCase();
  return mode === "saas" ? "saas" : "onprem";
}

export function isSaas() {
  return getDeployMode() === "saas";
}

export function isOnPrem() {
  return getDeployMode() === "onprem";
}

/** Public self-serve org create. Default off — set SAAS_OPEN_REGISTRATION=true to enable. */
export function isSaasOpenRegistration() {
  if (!isSaas()) return false;
  return String(readEnv("SAAS_OPEN_REGISTRATION") || "").trim().toLowerCase() === "true";
}

/** Remote /v1 must present an API key. Always on in SaaS; on-prem via REQUIRE_API_KEY=true. */
export function requireRemoteApiKey() {
  if (isSaas()) return true;
  return String(readEnv("REQUIRE_API_KEY") || "").trim().toLowerCase() === "true";
}

/** Request-body logging. SaaS is opt-in (`OBSERVABILITY_ENABLED=true`); on-prem defaults on unless explicitly false. */
export function isObservabilityEnvEnabled() {
  const raw = String(readEnv("OBSERVABILITY_ENABLED") || "").trim().toLowerCase();
  if (isSaas()) return raw === "true";
  return raw !== "false";
}

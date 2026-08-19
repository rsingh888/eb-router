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

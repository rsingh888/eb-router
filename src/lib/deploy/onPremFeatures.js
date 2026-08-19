/**
 * Features that require the host machine (ports, certs, hosts file, local CLI).
 * Shown only when DEPLOY_MODE=onprem. Hidden and API-blocked when SaaS.
 */

export const ONPREM_ONLY_PAGES = [
  "/dashboard/mitm",
  "/dashboard/cli-tools",
  "/dashboard/console-log",
  "/dashboard/translator",
  "/dashboard/pxpipe",
  "/dashboard/token-saver",
];

export const ONPREM_ONLY_API_PREFIXES = [
  "/api/cli-tools",
  "/api/tunnel",
  "/api/mcp/",
  "/api/headroom/start",
  "/api/headroom/stop",
  "/api/headroom/proxy",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  "/api/version/shutdown",
  "/api/version/update",
  "/api/shutdown",
  "/api/pxpipe",
];

export const SAAS_ONPREM_FEATURE_ERROR =
  "This feature is available in the local on-prem / CLI app only, not on SaaS.";

export function isOnPremOnlyPage(pathname) {
  const path = String(pathname || "");
  return ONPREM_ONLY_PAGES.some((p) => path === p || path.startsWith(`${p}/`));
}

export function isOnPremOnlyApi(pathname) {
  const path = String(pathname || "");
  return ONPREM_ONLY_API_PREFIXES.some((p) => path === p || path.startsWith(p));
}

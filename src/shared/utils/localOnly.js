import { UPDATER_CONFIG } from "@/shared/constants/config";

export const LOCAL_ONLY_ERROR = "Local only: CLI token required";

const APP_PORT = UPDATER_CONFIG.appPort || 20128;
const LOCAL_DASHBOARD = `http://localhost:${APP_PORT}/dashboard`;

export const LOCAL_ONLY_HINT =
  `This can only run on the machine hosting ebRouter. Open ${LOCAL_DASHBOARD} ` +
  `(start with \`npx ebrouter\` or \`npm run start\`), or use the CLI. ` +
  `A CLI token is a machine-id header the CLI sends automatically — browsers never have it.`;

export function isLocalOnlyError(error) {
  return String(error || "").includes(LOCAL_ONLY_ERROR);
}

export function formatLocalOnlyError(error, feature = "This feature") {
  if (!isLocalOnlyError(error) && !String(error || "").toLowerCase().includes("cli token")) {
    return error || "Request failed";
  }
  return `${feature} can only be started from localhost. Open ${LOCAL_DASHBOARD} after starting ebRouter locally (\`npx ebrouter\` or \`npm run start\`), or enable it from the CLI (Settings → Tunnel). Browsers cannot send a CLI token.`;
}

export function isBrowserLoopback() {
  if (typeof window === "undefined") return false;
  const host = String(window.location.hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

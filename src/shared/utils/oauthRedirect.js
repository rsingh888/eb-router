import { UPDATER_CONFIG } from "@/shared/constants/config";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Port for OAuth HTTP loopback (http://localhost:<port>/callback).
 *
 * Providers register localhost redirects, not the dashboard's public HTTPS origin.
 * `window.location.port` is empty on default HTTPS (443) / HTTP (80). Falling back
 * to 443 sent users to a port where nothing serves the Next.js /callback page
 * (MITM, if running, is TLS-only on 443). Use the ebRouter core port instead.
 */
export function getOAuthLoopbackPort() {
  const fallback = String(UPDATER_CONFIG.appPort || 20128);
  if (typeof window === "undefined") return fallback;

  const { protocol, hostname, port } = window.location;
  if (port) return port;

  const isLoopback = LOOPBACK_HOSTS.has(String(hostname || "").toLowerCase());
  if (isLoopback && protocol === "http:") return "80";
  return fallback;
}

export function getOAuthLoopbackRedirectUri(provider) {
  if (provider === "codex") return "http://localhost:1455/auth/callback";
  if (provider === "xai") return "http://127.0.0.1:56121/callback";
  return `http://localhost:${getOAuthLoopbackPort()}/callback`;
}

import { isOnPrem, isSaas } from "@/lib/deploy/deployMode.js";
import { getDefaultOrgId, getOrganizationById, getOrganizationBySlug } from "@/lib/db/repos/organizationsRepo.js";
import { getRuntimeOrgId, runWithOrgId } from "@/lib/auth/runtimeUserContext.js";
import { getConfiguredPublicUrl } from "@/lib/publicUrl.js";

export const ORG_SLUG_HEADER = "x-ebr-org-slug";
export const ORG_ID_HEADER = "x-ebr-org-id";

/** Wildcard-subdomain apex, if configured. `localhost` is not a public domain. */
export function getSaasBaseDomain() {
  const base = String(process.env.SAAS_BASE_DOMAIN || "").trim();
  if (!base || /^(localhost|127\.0\.0\.1)$/i.test(base)) return "";
  return base;
}

function hostnameOf(hostHeader) {
  return String(hostHeader || "").split(":")[0].toLowerCase();
}

/**
 * Derive org slug from URL path and Host only — never from client headers.
 * Used by middleware (to stamp a trusted internal header) and by handlers
 * that still have the original /o/:slug path (pre-rewrite).
 */
export function resolveOrgSlugFromHostAndPath(pathname, hostHeader) {
  const pathMatch = String(pathname || "").match(/^\/o\/([a-z0-9-]+)/i);
  if (pathMatch) return pathMatch[1].toLowerCase();

  const host = hostnameOf(hostHeader);
  const baseDomain = getSaasBaseDomain().toLowerCase();

  if (baseDomain) {
    if (host === baseDomain || host === `www.${baseDomain}`) return null;
    if (host.endsWith(`.${baseDomain}`)) {
      const sub = host.slice(0, -(baseDomain.length + 1));
      const slug = sub.split(".")[0];
      if (slug && slug !== "www") return slug;
    }
    return null;
  }

  // Local SaaS dev: {slug}.localhost
  if (host.endsWith(".localhost")) {
    const slug = host.slice(0, -".localhost".length).split(".")[0];
    if (slug && slug !== "www") return slug;
  }

  return null;
}

/**
 * Resolve org slug for a request.
 * Prefers Host / /o/:slug. Falls back to ORG_SLUG_HEADER (middleware stamp after
 * /o/ rewrite). Then same-origin Referer /o/:slug — Next can drop the path
 * after rewrite, and some handlers never see the stamped header.
 */
export function resolveOrgSlugFromRequest(request) {
  const url = new URL(request.url);
  const host = request.headers.get("host") || "";
  const fromUrl = resolveOrgSlugFromHostAndPath(url.pathname, host);
  if (fromUrl) return fromUrl;

  const nextPath = request.nextUrl?.pathname;
  if (nextPath && nextPath !== url.pathname) {
    const fromNext = resolveOrgSlugFromHostAndPath(nextPath, host);
    if (fromNext) return fromNext;
  }

  // Middleware-stamped after /o/:slug rewrite (path no longer carries the slug).
  const headerSlug = request.headers.get(ORG_SLUG_HEADER);
  if (headerSlug) return String(headerSlug).trim().toLowerCase();

  const fromQuery = String(url.searchParams.get("ebrOrg") || url.searchParams.get("orgSlug") || "").trim().toLowerCase();
  if (fromQuery) return fromQuery;

  const fromReferer = slugFromSameOriginReferer(request, url);
  if (fromReferer) return fromReferer;

  if (process.env.DEFAULT_ORG_SLUG) {
    return String(process.env.DEFAULT_ORG_SLUG).trim().toLowerCase();
  }

  return null;
}

function slugFromSameOriginReferer(request, requestUrl) {
  const referer = request.headers.get("referer") || request.headers.get("referrer") || "";
  if (!referer) return null;
  try {
    const ref = new URL(referer);
    if (ref.hostname !== requestUrl.hostname) return null;
    return resolveOrgSlugFromHostAndPath(ref.pathname, ref.host);
  } catch {
    return null;
  }
}

export async function resolveOrgFromRequest(request) {
  if (isOnPrem()) {
    const id = await getDefaultOrgId();
    return id ? getOrganizationById(id) : null;
  }

  const slug = resolveOrgSlugFromRequest(request);
  if (!slug) return null;
  return getOrganizationBySlug(slug);
}

/** Resolve org from JWT session or user record when URL/header lacks tenant slug (SaaS dashboard). */
export async function resolveOrgWithFallback(request, { session = null, user = null } = {}) {
  const fromRequest = await resolveOrgFromRequest(request);
  if (fromRequest) return fromRequest;

  if (session?.orgId) {
    const org = await getOrganizationById(session.orgId);
    if (org) return org;
  }
  if (session?.orgSlug) {
    const org = await getOrganizationBySlug(String(session.orgSlug).trim().toLowerCase());
    if (org) return org;
  }
  if (user?.orgId) {
    return getOrganizationById(user.orgId);
  }
  return null;
}

export async function requireOrgFromRequest(request) {
  const org = await resolveOrgFromRequest(request);
  if (org) return { org, error: null };

  if (isSaas()) {
    const { NextResponse } = await import("next/server");
    return {
      org: null,
      error: NextResponse.json({ error: "Organization not found" }, { status: 404 }),
    };
  }

  const id = await getDefaultOrgId();
  if (id) {
    const fallback = await getOrganizationById(id);
    if (fallback) return { org: fallback, error: null };
  }

  const { NextResponse } = await import("next/server");
  return {
    org: null,
    error: NextResponse.json({ error: "Organization not configured" }, { status: 503 }),
  };
}

/** Run handler with orgId in AsyncLocalStorage (for settings/users before session exists). */
export async function runWithRequestOrg(request, fn) {
  const org = await resolveOrgFromRequest(request);
  const orgId = org?.id || (isOnPrem() ? await getDefaultOrgId() : null);
  return runWithOrgId(orgId, fn);
}

function originFromRequest(request) {
  try {
    const url = new URL(request.url);
    const host = request.headers?.get?.("host") || url.host;
    return `${url.protocol}//${host}`.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * Org login/dashboard/signup URL — same shape as production:
 *   https://app.ebrouter.equalbyte.io/o/{slug}/login
 * Local register uses the current origin so it becomes:
 *   http://localhost:{port}/o/{slug}/login
 */
export function buildOrgDashboardUrl(slug, path = "/dashboard", { request = null, forcePublic = false } = {}) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const orgPath = `/o/${slug}${normalizedPath}`;

  if (!forcePublic && request) {
    const origin = originFromRequest(request);
    return origin ? `${origin}${orgPath}` : orgPath;
  }

  const baseUrl = getConfiguredPublicUrl();
  return baseUrl ? `${baseUrl}${orgPath}` : orgPath;
}

export function userBelongsToOrg(user, org) {
  if (!user || !org) return false;
  return user.orgId === org.id;
}

export async function resolveEffectiveOrgId(request) {
  const runtime = getRuntimeOrgId();
  if (runtime) return runtime;
  const org = await resolveOrgFromRequest(request);
  if (org?.id) return org.id;
  if (isOnPrem()) return getDefaultOrgId();
  return null;
}

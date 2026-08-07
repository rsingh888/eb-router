import { describe, it, expect, afterEach } from "vitest";
import {
  resolveOrgSlugFromHostAndPath,
  resolveOrgSlugFromRequest,
  ORG_SLUG_HEADER,
} from "../../src/lib/org/orgContext.js";
import {
  stripTrustedInternalHeaders,
  USER_ID_HEADER,
  USER_ROLE_HEADER,
  ORG_ID_HEADER,
} from "../../src/lib/auth/requestContext.js";

describe("resolveOrgSlugFromHostAndPath", () => {
  const prevBase = process.env.SAAS_BASE_DOMAIN;

  afterEach(() => {
    if (prevBase === undefined) delete process.env.SAAS_BASE_DOMAIN;
    else process.env.SAAS_BASE_DOMAIN = prevBase;
  });

  it("resolves /o/:slug path", () => {
    expect(resolveOrgSlugFromHostAndPath("/o/acme/api/auth/login", "app.example.com")).toBe("acme");
    expect(resolveOrgSlugFromHostAndPath("/o/Beta/dashboard", "localhost")).toBe("beta");
  });

  it("resolves subdomain when SAAS_BASE_DOMAIN is set", () => {
    process.env.SAAS_BASE_DOMAIN = "example.com";
    expect(resolveOrgSlugFromHostAndPath("/api/auth/login", "acme.example.com")).toBe("acme");
    expect(resolveOrgSlugFromHostAndPath("/login", "www.example.com")).toBeNull();
    expect(resolveOrgSlugFromHostAndPath("/login", "example.com")).toBeNull();
  });

  it("resolves {slug}.localhost for local SaaS", () => {
    delete process.env.SAAS_BASE_DOMAIN;
    expect(resolveOrgSlugFromHostAndPath("/api/auth/oidc/callback", "acme.localhost:20128")).toBe("acme");
  });

  it("does not use path slug from unrelated paths", () => {
    expect(resolveOrgSlugFromHostAndPath("/api/auth/login", "localhost")).toBeNull();
  });
});

describe("resolveOrgSlugFromRequest prefers Host/path over client header", () => {
  const prevBase = process.env.SAAS_BASE_DOMAIN;
  const prevDefault = process.env.DEFAULT_ORG_SLUG;

  afterEach(() => {
    if (prevBase === undefined) delete process.env.SAAS_BASE_DOMAIN;
    else process.env.SAAS_BASE_DOMAIN = prevBase;
    if (prevDefault === undefined) delete process.env.DEFAULT_ORG_SLUG;
    else process.env.DEFAULT_ORG_SLUG = prevDefault;
  });

  function fakeRequest({ pathname, host, headers = {} }) {
    const h = new Headers(headers);
    if (host) h.set("host", host);
    return {
      url: `http://${host || "localhost"}${pathname}`,
      headers: h,
    };
  }

  it("ignores spoofed org header when Host subdomain disagrees", () => {
    process.env.SAAS_BASE_DOMAIN = "example.com";
    const slug = resolveOrgSlugFromRequest(
      fakeRequest({
        pathname: "/api/auth/oidc/callback",
        host: "acme.example.com",
        headers: { [ORG_SLUG_HEADER]: "victim-org" },
      }),
    );
    expect(slug).toBe("acme");
  });

  it("uses /o/:slug path over spoofed header", () => {
    const slug = resolveOrgSlugFromRequest(
      fakeRequest({
        pathname: "/o/acme/api/auth/login",
        host: "localhost",
        headers: { [ORG_SLUG_HEADER]: "victim-org" },
      }),
    );
    expect(slug).toBe("acme");
  });

  it("uses middleware-stamped header after path rewrite (no /o/ left)", () => {
    const slug = resolveOrgSlugFromRequest(
      fakeRequest({
        pathname: "/api/auth/login",
        host: "localhost",
        headers: { [ORG_SLUG_HEADER]: "acme" },
      }),
    );
    expect(slug).toBe("acme");
  });
});

describe("stripTrustedInternalHeaders", () => {
  it("removes all x-ebr-* identity/tenant headers", () => {
    const headers = new Headers({
      [USER_ID_HEADER]: "attacker",
      [USER_ROLE_HEADER]: "admin",
      [ORG_ID_HEADER]: "org-x",
      [ORG_SLUG_HEADER]: "victim",
      "x-ebr-custom": "nope",
      "content-type": "application/json",
    });
    const cleaned = stripTrustedInternalHeaders(headers);
    expect(cleaned.get(USER_ID_HEADER)).toBeNull();
    expect(cleaned.get(USER_ROLE_HEADER)).toBeNull();
    expect(cleaned.get(ORG_ID_HEADER)).toBeNull();
    expect(cleaned.get(ORG_SLUG_HEADER)).toBeNull();
    expect(cleaned.get("x-ebr-custom")).toBeNull();
    expect(cleaned.get("content-type")).toBe("application/json");
  });
});

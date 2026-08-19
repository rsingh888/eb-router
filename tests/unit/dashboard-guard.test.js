import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  lastNextInit: null,
  lastRewrite: null,
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  isSaas: vi.fn(() => false),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn((init) => {
      mocks.lastNextInit = init;
      return mocks.nextResponse;
    }),
    rewrite: vi.fn((url, init) => {
      mocks.lastRewrite = { url, init };
      return { type: "rewrite", url, init };
    }),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
  isApiKeyValid: mocks.validateApiKey,
}));

vi.mock("@/lib/auth/requestContext", () => {
  const USER_ID_HEADER = "x-ebr-user-id";
  const USER_ROLE_HEADER = "x-ebr-user-role";
  const ORG_ID_HEADER = "x-ebr-org-id";
  const TRUSTED = [USER_ID_HEADER, USER_ROLE_HEADER, ORG_ID_HEADER, "x-ebr-org-slug"];

  function stripTrustedInternalHeaders(headers) {
    const next = new Headers(headers);
    for (const key of TRUSTED) next.delete(key);
    for (const key of [...next.keys()]) {
      if (key.toLowerCase().startsWith("x-ebr-")) next.delete(key);
    }
    return next;
  }

  function attachUserHeaders(requestOrHeaders, user) {
    const base =
      requestOrHeaders instanceof Headers
        ? requestOrHeaders
        : requestOrHeaders?.headers || requestOrHeaders;
    const headers = stripTrustedInternalHeaders(base);
    headers.set(USER_ID_HEADER, user.id);
    headers.set(USER_ROLE_HEADER, user.role);
    if (user.orgId) headers.set(ORG_ID_HEADER, user.orgId);
    return headers;
  }

  return {
    USER_ID_HEADER,
    USER_ROLE_HEADER,
    ORG_ID_HEADER,
    stripTrustedInternalHeaders,
    attachUserHeaders,
    getCliContextUser: vi.fn(async () => ({ id: "admin-id", role: "admin", status: "active", orgId: "org-1" })),
    getSessionUser: vi.fn(async () => null),
  };
});

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
  getDashboardAuthSession: vi.fn(async () => null),
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/deploy/deployMode.js", () => ({
  isSaas: () => mocks.isSaas(),
  isOnPrem: () => !mocks.isSaas(),
  getDeployMode: () => (mocks.isSaas() ? "saas" : "onprem"),
}));

const { proxy, __test__ } = await import("../../src/dashboardGuard.js");

function request(pathname, headers = {}) {
  const normalizedHeaders = new Headers(headers);
  const parsed = new URL(`http://localhost${pathname}`);
  return {
    nextUrl: {
      pathname: parsed.pathname,
      searchParams: parsed.searchParams,
      clone() {
        return { pathname: parsed.pathname, searchParams: parsed.searchParams };
      },
    },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => undefined) },
    url: `http://${headers.host || "localhost"}${pathname}`,
  };
}

function forwardedHeaders(response) {
  if (response === mocks.nextResponse) {
    return mocks.lastNextInit?.request?.headers || null;
  }
  if (response?.type === "rewrite") {
    return response.init?.request?.headers || null;
  }
  return null;
}

describe("dashboard guard public LLM API access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.isSaas.mockReturnValue(false);
  });

  it("allows loopback public LLM API without API key", async () => {
    const response = await proxy(request("/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote Host-spoof when real peer IP is non-loopback", async () => {
    const response = await proxy(request("/v1/chat/completions", {
      host: "localhost",
      "x-9r-real-ip": "10.204.111.34",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback peer IP regardless of Host", async () => {
    const response = await proxy(request("/v1/chat/completions", {
      host: "localhost:20128",
      "x-9r-real-ip": "127.0.0.1",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote rewritten public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1/chat/completions", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback rewritten public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote beta public LLM API without API key", async () => {
    const response = await proxy(request("/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote rewritten beta public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote codex rewrite without API key", async () => {
    const response = await proxy(request("/codex/x", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows remote codex rewrite with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/codex/x", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid bearer API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1/chat/completions", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid x-api-key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1/web/fetch", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote rewritten beta public LLM API with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1beta/models", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google API key header", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models", {
      host: "router.example.com",
      "x-goog-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google key query parameter", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models?key=sk-valid", {
      host: "router.example.com",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });
});

describe("dashboard guard local-only access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.isSaas.mockReturnValue(false);
  });

  it("allows remote password reset without CLI token", async () => {
    const response = await proxy(request("/api/auth/reset-password", {
      host: "app.ebrouter.equalbyte.io",
      origin: "https://app.ebrouter.equalbyte.io",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route from non-loopback host without CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("rejects local-only route on loopback when requireLogin=true and no JWT", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("allows local-only route on loopback when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route from tunnel host even when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("rejects local-only route when Origin is non-loopback (CSRF block)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://evil.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("allows local-only route with valid CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
      "x-9r-cli-token": "cli-token",
    }));

    expect(response).toBe(mocks.nextResponse);
  });
});

describe("dashboard guard SaaS hides on-prem features", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    mocks.isSaas.mockReturnValue(true);
  });

  it("returns 404 for MITM API on SaaS even with CLI token", async () => {
    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "app.ebrouter.equalbyte.io",
      "x-9r-cli-token": "cli-token",
    }));

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/on-prem/i);
  });

  it("redirects MITM dashboard page to endpoint on SaaS", async () => {
    const response = await proxy(request("/dashboard/mitm", {
      host: "app.ebrouter.equalbyte.io",
    }));

    expect(response.status).toBe(307);
  });
});

describe("dashboard guard helpers", () => {
  it("extracts bearer API keys before x-api-key", () => {
    const apiRequest = request("/v1/chat/completions", {
      authorization: "Bearer bearer-key",
      "x-api-key": "header-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("bearer-key");
  });

  it("extracts Google API keys after x-api-key", () => {
    const apiRequest = request("/v1beta/models?key=query-key", {
      "x-api-key": "header-key",
      "x-goog-api-key": "google-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("header-key");
  });
});

describe("dashboard guard trusted header perimeter", () => {
  const prevBase = process.env.SAAS_BASE_DOMAIN;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lastNextInit = null;
    mocks.lastRewrite = null;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.isSaas.mockReturnValue(false);
  });

  afterEach(() => {
    if (prevBase === undefined) delete process.env.SAAS_BASE_DOMAIN;
    else process.env.SAAS_BASE_DOMAIN = prevBase;
  });

  it("strips spoofed org/user headers on public auth paths", async () => {
    process.env.SAAS_BASE_DOMAIN = "example.com";
    const response = await proxy(request("/api/auth/login", {
      host: "example.com",
      "x-ebr-org-slug": "victim-org",
      "x-ebr-user-id": "attacker",
      "x-ebr-user-role": "admin",
      "x-ebr-org-id": "org-x",
    }));

    expect(response).toBe(mocks.nextResponse);
    const headers = forwardedHeaders(response);
    expect(headers.get("x-ebr-org-slug")).toBeNull();
    expect(headers.get("x-ebr-user-id")).toBeNull();
    expect(headers.get("x-ebr-user-role")).toBeNull();
    expect(headers.get("x-ebr-org-id")).toBeNull();
  });

  it("stamps org slug from subdomain and strips spoofed user headers", async () => {
    process.env.SAAS_BASE_DOMAIN = "example.com";
    const response = await proxy(request("/api/auth/oidc/callback", {
      host: "acme.example.com",
      "x-ebr-org-slug": "victim-org",
      "x-ebr-user-id": "attacker",
    }));

    expect(response).toBe(mocks.nextResponse);
    const headers = forwardedHeaders(response);
    expect(headers.get("x-ebr-org-slug")).toBe("acme");
    expect(headers.get("x-ebr-user-id")).toBeNull();
  });

  it("rewrites /o/:slug and stamps trusted org slug", async () => {
    const response = await proxy(request("/o/acme/api/auth/login", {
      host: "localhost:20128",
      "x-ebr-org-slug": "victim-org",
      "x-ebr-user-role": "admin",
    }));

    expect(response.type).toBe("rewrite");
    expect(response.url.pathname).toBe("/api/auth/login");
    expect(response.url.searchParams.get("ebrOrg")).toBe("acme");
    const headers = forwardedHeaders(response);
    expect(headers.get("x-ebr-org-slug")).toBe("acme");
    expect(headers.get("x-ebr-user-role")).toBeNull();
  });

  it("buildOrgRequestContext never forwards client x-ebr-* without stamping", () => {
    process.env.SAAS_BASE_DOMAIN = "example.com";
    const ctx = __test__.buildOrgRequestContext(request("/api/auth/status", {
      host: "beta.example.com",
      "x-ebr-org-slug": "spoofed",
      "x-ebr-user-id": "u1",
    }));
    expect(ctx.slug).toBe("beta");
    expect(ctx.headers.get("x-ebr-org-slug")).toBe("beta");
    expect(ctx.headers.get("x-ebr-user-id")).toBeNull();
  });
});

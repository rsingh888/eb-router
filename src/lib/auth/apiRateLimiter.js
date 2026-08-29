// Sliding-window rate limiter for LLM API endpoints (/v1, /api/v1).
import { consumeRateLimit } from "./sharedRateLimit.js";

const DEFAULT_IP_LIMIT = Number(process.env.API_RATE_LIMIT_PER_MIN || 120);
const DEFAULT_KEY_LIMIT = Number(process.env.API_RATE_LIMIT_PER_KEY_PER_MIN || 300);
const WINDOW_MS = 60_000;

export async function checkApiRateLimit({ ip, apiKey } = {}) {
  const ipResult = await consumeRateLimit({
    scope: "api-ip",
    key: ip || "unknown",
    windowMs: WINDOW_MS,
    limit: DEFAULT_IP_LIMIT,
  });
  if (!ipResult.allowed) return { ...ipResult, scope: "ip" };

  if (apiKey) {
    const keyResult = await consumeRateLimit({
      scope: "api-key",
      key: apiKey,
      windowMs: WINDOW_MS,
      limit: DEFAULT_KEY_LIMIT,
    });
    if (!keyResult.allowed) return { ...keyResult, scope: "api_key" };
    return { allowed: true, retryAfter: 0, remaining: keyResult.remaining, scope: "api_key" };
  }

  return { allowed: true, retryAfter: 0, remaining: ipResult.remaining, scope: "ip" };
}

export const __test__ = { WINDOW_MS, DEFAULT_IP_LIMIT, DEFAULT_KEY_LIMIT };

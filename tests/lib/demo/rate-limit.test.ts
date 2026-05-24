import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { IP_HASH_SALT: "test-salt" },
}));

import {
  checkRateLimit,
  extractClientIp,
  _resetRateLimitForTest,
} from "@/lib/demo/rate-limit";

beforeEach(() => {
  _resetRateLimitForTest();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkRateLimit", () => {
  it("allows the first 5 calls from the same IP and denies the 6th", () => {
    for (let i = 0; i < 5; i++) {
      const res = checkRateLimit("203.0.113.5");
      expect(res.allowed).toBe(true);
    }
    const denied = checkRateLimit("203.0.113.5");
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.retryAfterSeconds).toBeGreaterThan(0);
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
  });

  it("allows again after the 1-hour sliding window passes", () => {
    vi.useFakeTimers();
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    vi.setSystemTime(t0);

    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit("198.51.100.7").allowed).toBe(true);
    }
    expect(checkRateLimit("198.51.100.7").allowed).toBe(false);

    // Advance past the window (1 hour + 1 ms)
    vi.setSystemTime(t0 + 60 * 60 * 1000 + 1);
    const res = checkRateLimit("198.51.100.7");
    expect(res.allowed).toBe(true);
  });

  it("tracks different IPs in separate buckets", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit("203.0.113.10").allowed).toBe(true);
    }
    expect(checkRateLimit("203.0.113.10").allowed).toBe(false);

    // A different IP still has its full budget.
    expect(checkRateLimit("203.0.113.11").allowed).toBe(true);
  });
});

describe("extractClientIp", () => {
  it("prefers x-vercel-forwarded-for", () => {
    const h = new Headers({
      "x-vercel-forwarded-for": "203.0.113.1",
      "x-forwarded-for": "203.0.113.2",
      "x-real-ip": "203.0.113.3",
    });
    expect(extractClientIp(h)).toBe("203.0.113.1");
  });

  it("falls back to first value in x-forwarded-for", () => {
    const h = new Headers({
      "x-forwarded-for": "203.0.113.20, 10.0.0.1, 10.0.0.2",
    });
    expect(extractClientIp(h)).toBe("203.0.113.20");
  });

  it("falls back to x-real-ip", () => {
    const h = new Headers({ "x-real-ip": "203.0.113.40" });
    expect(extractClientIp(h)).toBe("203.0.113.40");
  });

  it('returns "unknown" when no IP header is present', () => {
    expect(extractClientIp(new Headers())).toBe("unknown");
  });
});

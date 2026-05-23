import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { mcpCall: { count: vi.fn() } },
}));

import { db } from "@/lib/db";
import { checkRateLimit, RATE_LIMITS } from "@/lib/mcp/rate-limit";

beforeEach(() => vi.clearAllMocks());

describe("checkRateLimit", () => {
  it("returns { ok: true } when all counters are well below their caps", async () => {
    (db.mcpCall.count as any).mockResolvedValue(0);
    const res = await checkRateLimit("u1", "list_reviews");
    expect(res).toEqual({ ok: true });
  });

  it("returns { ok: false, retryAfter } when per-minute cap is hit", async () => {
    (db.mcpCall.count as any)
      .mockResolvedValueOnce(RATE_LIMITS.perMinute)      // all-tools/min
      .mockResolvedValueOnce(0)                          // per-tool/min
      .mockResolvedValueOnce(0);                         // daily
    const res = await checkRateLimit("u1", "list_reviews");
    expect(res).toEqual({ ok: false, retryAfter: 60, errorCode: "rate_limited" });
  });

  it("returns { ok: false } when per-tool cap is hit", async () => {
    (db.mcpCall.count as any)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(RATE_LIMITS.perToolPerMinute)
      .mockResolvedValueOnce(0);
    const res = await checkRateLimit("u1", "list_reviews");
    expect(res).toEqual({ ok: false, retryAfter: 60, errorCode: "rate_limited" });
  });

  it("returns { ok: false } when daily cap is hit (retryAfter to next UTC midnight)", async () => {
    const now = new Date("2026-05-24T20:00:00Z").getTime();
    vi.setSystemTime(now);
    (db.mcpCall.count as any)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(RATE_LIMITS.perDay);
    const res = await checkRateLimit("u1", "list_reviews");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // 20:00 UTC → next midnight is 4 hours = 14400 seconds
      expect(res.retryAfter).toBe(4 * 3600);
    }
    vi.useRealTimers();
  });

  it("counts ERROR rows alongside OK rows toward the limit", async () => {
    (db.mcpCall.count as any).mockResolvedValue(0);
    await checkRateLimit("u1", "list_reviews");
    // First call: per-minute (no status filter)
    expect(db.mcpCall.count).toHaveBeenNthCalledWith(1, {
      where: expect.objectContaining({
        userId: "u1",
        createdAt: expect.any(Object),
      }),
    });
    // The where clause must NOT include a status filter
    const firstCall = (db.mcpCall.count as any).mock.calls[0][0];
    expect(firstCall.where.status).toBeUndefined();
  });
});

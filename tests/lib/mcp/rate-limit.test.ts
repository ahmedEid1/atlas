import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { mcpCall: { count: vi.fn(), findFirst: vi.fn() } },
}));

import { db } from "@/lib/db";
import { checkRateLimit, RATE_LIMITS } from "@/lib/mcp/rate-limit";

beforeEach(() => vi.clearAllMocks());

describe("checkRateLimit", () => {
  it("returns { ok: true } when all counters are well below their caps", async () => {
    vi.mocked(db.mcpCall.count).mockResolvedValue(0 as never);
    const res = await checkRateLimit("u1", "list_reviews");
    expect(res).toEqual({ ok: true });
  });

  it("returns { ok: false, retryAfter } when per-minute cap is hit", async () => {
    vi.mocked(db.mcpCall.count)
      .mockResolvedValueOnce(RATE_LIMITS.perMinute as never)      // all-tools/min
      .mockResolvedValueOnce(0 as never)                          // per-tool/min
      .mockResolvedValueOnce(0 as never);                         // daily
    const res = await checkRateLimit("u1", "list_reviews");
    expect(res).toEqual({ ok: false, retryAfter: 60, errorCode: "rate_limited" });
  });

  it("returns { ok: false } when per-tool cap is hit", async () => {
    vi.mocked(db.mcpCall.count)
      .mockResolvedValueOnce(0 as never)
      .mockResolvedValueOnce(RATE_LIMITS.perToolPerMinute as never)
      .mockResolvedValueOnce(0 as never);
    const res = await checkRateLimit("u1", "list_reviews");
    expect(res).toEqual({ ok: false, retryAfter: 60, errorCode: "rate_limited" });
  });

  it("returns { ok: false } with accurate retryAfter when daily cap is hit", async () => {
    vi.mocked(db.mcpCall.count)
      .mockResolvedValueOnce(0 as never)
      .mockResolvedValueOnce(0 as never)
      .mockResolvedValueOnce(RATE_LIMITS.perDay as never);
    // Oldest in-window call is 23h old, so the window slides in ~3600s.
    const twentyThreeHoursAgo = new Date(Date.now() - 23 * 3600_000);
    vi.mocked(db.mcpCall.findFirst).mockResolvedValueOnce({ createdAt: twentyThreeHoursAgo } as never);

    const res = await checkRateLimit("u1", "list_reviews");
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.errorCode).toBe("rate_limited");
      // 3600 ± slack for the wall-clock between Date.now() calls
      expect(res.retryAfter).toBeGreaterThan(3590);
      expect(res.retryAfter).toBeLessThanOrEqual(3600);
    }
  });

  it("falls back to retryAfter=60 if daily-window oldest row can't be found", async () => {
    // Defensive path: count says 1000 but findFirst returns null (race / data
    // anomaly). Must not crash — falls back to the minute-cap value.
    vi.mocked(db.mcpCall.count)
      .mockResolvedValueOnce(0 as never)
      .mockResolvedValueOnce(0 as never)
      .mockResolvedValueOnce(RATE_LIMITS.perDay as never);
    vi.mocked(db.mcpCall.findFirst).mockResolvedValueOnce(null as never);

    const res = await checkRateLimit("u1", "list_reviews");
    expect(res).toEqual({ ok: false, retryAfter: 60, errorCode: "rate_limited" });
  });

  it("counts ERROR rows alongside OK rows toward the limit", async () => {
    vi.mocked(db.mcpCall.count).mockResolvedValue(0 as never);
    await checkRateLimit("u1", "list_reviews");
    // First call: per-minute (no status filter)
    expect(db.mcpCall.count).toHaveBeenNthCalledWith(1, {
      where: expect.objectContaining({
        userId: "u1",
        createdAt: expect.any(Object),
      }),
    });
    // The where clause must NOT include a status filter
    const firstCall = vi.mocked(db.mcpCall.count).mock.calls[0]![0]!;
    expect(firstCall.where!.status).toBeUndefined();
  });
});

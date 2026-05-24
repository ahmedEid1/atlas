import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { mcpCall: { count: vi.fn() } },
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

  it("returns { ok: false } when daily cap is hit", async () => {
    vi.mocked(db.mcpCall.count)
      .mockResolvedValueOnce(0 as never)
      .mockResolvedValueOnce(0 as never)
      .mockResolvedValueOnce(RATE_LIMITS.perDay as never);
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

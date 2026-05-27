import { db } from "@/lib/db";

export const RATE_LIMITS = {
  perMinute: 60,            // all tools, per user, last 60s
  perToolPerMinute: 30,     // per tool, per user, last 60s
  perDay: 1000,             // all tools, per user, last 24h
} as const;

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfter: number; errorCode: "rate_limited" };

const DAY_MS = 24 * 3600_000;

/**
 * DB-backed sliding window check. Rate-limited responses are themselves
 * written to McpCall (with status=ERROR, errorCode=rate_limited), so they
 * count toward the user's window — preventing a spam-the-limit loophole.
 *
 * Uses the (userId, createdAt) and (userId, toolName, createdAt) indexes
 * on McpCall — see prisma/schema.prisma.
 *
 * Daily cap is checked before the minute caps: when the daily window is
 * the binding constraint, the user can't succeed for up to 24h, so we run
 * one extra `findFirst` to compute exactly when the oldest day-call
 * expires and emit that as `retryAfter`. Returning 60 here (as the
 * minute paths do) would tell the client to retry in 60s and have it
 * hammer the cap fruitlessly for hours.
 *
 * Minute caps stay at a 60s ceiling — the sliding-window error is bounded
 * by the window itself, so the extra findFirst doesn't buy anything
 * meaningful.
 */
export async function checkRateLimit(
  userId: string,
  toolName: string,
): Promise<RateLimitResult> {
  const now = Date.now();
  const oneMinuteAgo = new Date(now - 60_000);
  const oneDayAgo = new Date(now - DAY_MS);

  const [perMinute, perToolMinute, perDay] = await Promise.all([
    db.mcpCall.count({ where: { userId, createdAt: { gte: oneMinuteAgo } } }),
    db.mcpCall.count({ where: { userId, toolName, createdAt: { gte: oneMinuteAgo } } }),
    db.mcpCall.count({ where: { userId, createdAt: { gte: oneDayAgo } } }),
  ]);

  if (perDay >= RATE_LIMITS.perDay) {
    const oldest = await db.mcpCall.findFirst({
      where: { userId, createdAt: { gte: oneDayAgo } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    const retryAfter = oldest
      ? Math.max(1, Math.ceil((oldest.createdAt.getTime() + DAY_MS - now) / 1000))
      : 60;
    return { ok: false, retryAfter, errorCode: "rate_limited" };
  }
  if (perMinute >= RATE_LIMITS.perMinute) {
    return { ok: false, retryAfter: 60, errorCode: "rate_limited" };
  }
  if (perToolMinute >= RATE_LIMITS.perToolPerMinute) {
    return { ok: false, retryAfter: 60, errorCode: "rate_limited" };
  }
  return { ok: true };
}

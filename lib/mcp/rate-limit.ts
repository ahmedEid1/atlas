import { db } from "@/lib/db";

export const RATE_LIMITS = {
  perMinute: 60,            // all tools, per user, last 60s
  perToolPerMinute: 30,     // per tool, per user, last 60s
  perDay: 1000,             // all tools, per user, last 24h
} as const;

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfter: number; errorCode: "rate_limited" };

/**
 * DB-backed sliding window check. Rate-limited responses are themselves
 * written to McpCall (with status=ERROR, errorCode=rate_limited), so they
 * count toward the user's window — preventing a spam-the-limit loophole.
 *
 * Uses the (userId, createdAt) and (userId, toolName, createdAt) indexes
 * on McpCall — see prisma/schema.prisma.
 */
export async function checkRateLimit(
  userId: string,
  toolName: string,
): Promise<RateLimitResult> {
  const now = Date.now();
  const oneMinuteAgo = new Date(now - 60_000);
  const oneDayAgo = new Date(now - 24 * 3600_000);

  const [perMinute, perToolMinute, perDay] = await Promise.all([
    db.mcpCall.count({ where: { userId, createdAt: { gte: oneMinuteAgo } } }),
    db.mcpCall.count({ where: { userId, toolName, createdAt: { gte: oneMinuteAgo } } }),
    db.mcpCall.count({ where: { userId, createdAt: { gte: oneDayAgo } } }),
  ]);

  if (perMinute >= RATE_LIMITS.perMinute) {
    return { ok: false, retryAfter: 60, errorCode: "rate_limited" };
  }
  if (perToolMinute >= RATE_LIMITS.perToolPerMinute) {
    return { ok: false, retryAfter: 60, errorCode: "rate_limited" };
  }
  if (perDay >= RATE_LIMITS.perDay) {
    return { ok: false, retryAfter: 60, errorCode: "rate_limited" };
  }
  return { ok: true };
}

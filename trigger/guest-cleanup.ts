import { schedules, logger } from "@trigger.dev/sdk";
import { clerkClient } from "@clerk/nextjs/server";
import { db } from "@/lib/db";

/**
 * Scheduled cleanup of stale guest accounts created by /api/demo/start.
 *
 * Runs every 6 hours. Considers any User row with `isGuest = true` and
 * `createdAt < now - 24h`. For each:
 *   1. Best-effort delete of the matching Clerk user (so the guest's
 *      Clerk account doesn't linger in the dashboard).
 *   2. Delete the local User row. Prisma cascade tears down the guest's
 *      Project + corpus + runs + everything else owned downstream.
 *
 * Clerk-delete failures are tolerated: the local DB cleanup still runs
 * so guest projects don't pile up if Clerk has an outage. A second pass
 * will pick the Clerk side up later (the guest row is gone after the
 * local delete, so the operator would clean those orphans manually if
 * they accumulate — flagged in the final log line).
 */
const CUTOFF_HOURS = 24;

export const guestCleanupTask = schedules.task({
  id: "guest-cleanup",
  // Every 6 hours, on the hour, UTC. Cron format: min hour dom month dow.
  cron: "0 */6 * * *",
  maxDuration: 300,
  run: async () => {
    const cutoff = new Date(Date.now() - CUTOFF_HOURS * 60 * 60 * 1000);

    const candidates = await db.user.findMany({
      where: { isGuest: true, createdAt: { lt: cutoff } },
      select: { id: true, clerkId: true, email: true },
    });

    if (candidates.length === 0) {
      logger.info("guest-cleanup: no stale guests", {
        cutoffIso: cutoff.toISOString(),
      });
      return { considered: 0, cleaned: 0, clerkFailures: 0 };
    }

    const clerk = await clerkClient();

    let cleaned = 0;
    let clerkFailures = 0;

    for (const guest of candidates) {
      // Clerk delete first — if it succeeds, no orphan in Clerk; if it
      // fails, we still proceed to the local delete so the row doesn't
      // block the next cron run.
      try {
        await clerk.users.deleteUser(guest.clerkId);
      } catch (err) {
        clerkFailures += 1;
        logger.warn("guest-cleanup: clerk delete failed (continuing)", {
          atlasUserId: guest.id,
          clerkId: guest.clerkId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        await db.user.delete({ where: { id: guest.id } });
        cleaned += 1;
      } catch (err) {
        logger.error("guest-cleanup: local delete failed", {
          atlasUserId: guest.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("guest-cleanup: done", {
      considered: candidates.length,
      cleaned,
      clerkFailures,
      cutoffIso: cutoff.toISOString(),
    });

    return {
      considered: candidates.length,
      cleaned,
      clerkFailures,
    };
  },
});

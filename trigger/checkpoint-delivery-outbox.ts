import { schedules, logger } from "@trigger.dev/sdk";
import { db } from "@/lib/db";
import { deliverCheckpoint } from "@/lib/agent/checkpoint-delivery";

/**
 * Recovery outbox for stranded HITL checkpoints.
 *
 * After Phase 3.2 (commit 1d275f5), the approve/reject routes split
 * decision commit (Phase 1) from delivery to Trigger.dev (Phase 2). If
 * Phase 2 fails AFTER Phase 1 commits (e.g. a Trigger.dev 5xx, network
 * partition, or worker crash between resolveWaitToken and the waitToken
 * null-out), the checkpoint is "stranded": status != PENDING but
 * waitToken is still set. The UI hides resolved checkpoints, so the
 * user has no surface to retry; the agent would otherwise wait until
 * the wait-token's natural timeout.
 *
 * This cron polls every minute for stranded rows and re-runs the shared
 * deliverCheckpoint helper (the same one the routes call for Phase 2).
 * The helper acquires a per-checkpoint advisory lock and replays the
 * PERSISTED decisionPayload, so:
 *   - a concurrent UI retry and the cron will serialize on the lock —
 *     exactly one delivery wins
 *   - the agent always sees the originally committed decision; the
 *     cron cannot substitute its own payload
 *
 * If Trigger.dev is down for an extended period, the outbox will retry
 * on every tick — that is intentional. Once Trigger recovers, the next
 * tick delivers and the row drops out of the candidate set.
 *
 * Batch is capped at 50 rows per tick so a one-time backlog after a
 * long outage doesn't fan out into a thundering herd.
 */
export const checkpointDeliveryOutboxTask = schedules.task({
  id: "checkpoint-delivery-outbox",
  // Every minute, UTC. Cron format: min hour dom month dow.
  cron: "* * * * *",
  maxDuration: 300,
  run: async () => {
    const stranded = await db.humanCheckpoint.findMany({
      where: {
        status: { not: "PENDING" },
        waitToken: { not: null },
      },
      select: {
        id: true,
        runId: true,
        status: true,
        createdAt: true,
        decidedAt: true,
      },
      // Cap the batch so a one-time backlog doesn't all run at once.
      take: 50,
      orderBy: { decidedAt: "asc" },
    });

    if (stranded.length === 0) {
      logger.info("checkpoint-outbox: nothing to deliver");
      return {
        considered: 0,
        delivered: 0,
        alreadyDelivered: 0,
        errors: 0,
      };
    }

    let delivered = 0;
    let alreadyDelivered = 0;
    let errors = 0;

    for (const cp of stranded) {
      try {
        const r = await deliverCheckpoint(cp.id);
        if (r.outcome === "delivered") delivered += 1;
        else if (r.outcome === "already_delivered") alreadyDelivered += 1;
      } catch (err) {
        errors += 1;
        logger.error("checkpoint-outbox: delivery failed", {
          checkpointId: cp.id,
          runId: cp.runId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("checkpoint-outbox: done", {
      considered: stranded.length,
      delivered,
      alreadyDelivered,
      errors,
    });

    return {
      considered: stranded.length,
      delivered,
      alreadyDelivered,
      errors,
    };
  },
});

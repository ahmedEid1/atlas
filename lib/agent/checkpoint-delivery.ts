import { db } from "@/lib/db";
import { resolveWaitToken } from "@/lib/trigger-client";

export type CheckpointDeliveryOutcome =
  | { outcome: "delivered" }
  | { outcome: "already_delivered" }
  | { outcome: "not_found" };

/**
 * Atomically deliver a HumanCheckpoint's wait-token to Trigger.dev and
 * null the token. Uses a per-checkpoint Postgres advisory lock so
 * concurrent callers (UI retry, outbox cron, recovery branch in
 * approve/reject) serialize on the same checkpoint.
 *
 * Always uses the PERSISTED decisionPayload — never an external payload —
 * so retries after a partial failure can't substitute their own decision.
 * Trigger.dev's wait.completeToken is documented idempotent (no-op success
 * on already-completed tokens), so a re-delivery after a rolled-back
 * null-out is safe.
 *
 * Returns:
 *   - delivered: this call successfully delivered (or re-delivered) the token
 *   - already_delivered: waitToken was null when we got the lock — someone
 *     else got there first
 *   - not_found: checkpoint row no longer exists
 */
export async function deliverCheckpoint(
  checkpointId: string,
): Promise<CheckpointDeliveryOutcome> {
  return db.$transaction(
    async (tx): Promise<CheckpointDeliveryOutcome> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${checkpointId}))`;
      const row = await tx.humanCheckpoint.findUnique({
        where: { id: checkpointId },
        select: { waitToken: true, decisionPayload: true },
      });
      if (!row) return { outcome: "not_found" };
      if (!row.waitToken) return { outcome: "already_delivered" };
      await resolveWaitToken(
        row.waitToken,
        (row.decisionPayload ?? {}) as Record<string, unknown>,
      );
      await tx.humanCheckpoint.update({
        where: { id: checkpointId },
        data: { waitToken: null },
      });
      return { outcome: "delivered" };
    },
    { timeout: 30_000 },
  );
}

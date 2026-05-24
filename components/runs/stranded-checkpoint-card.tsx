import { CheckpointRetryButton } from "@/components/runs/checkpoint-retry-button";

type StrandedCheckpoint = {
  id: string;
  kind: string;
  status: string;
};

/**
 * Editorial card rendered when a checkpoint is "stranded" — the user's
 * decision committed in Phase 1 (status != PENDING) but Phase 2 delivery
 * to Trigger.dev never succeeded, so the agent is still parked on the
 * wait-token. The cron outbox retries every minute; this card surfaces
 * the failure mode and offers an immediate manual retry.
 *
 * Visually subordinate: small, warn-coloured, no border emphasis. The
 * primary action UI (approve/reject) is already gone by the time a
 * checkpoint can be stranded.
 */
export function StrandedCheckpointCard({
  runId,
  checkpoint,
}: {
  runId: string;
  checkpoint: StrandedCheckpoint;
}) {
  const decision = checkpoint.status === "APPROVED" ? "approved" : "rejected";
  return (
    <aside
      role="status"
      aria-live="polite"
      className="rounded-md border border-[var(--thoth-rule)] p-4 space-y-2 bg-[var(--thoth-warn)]/[0.04]"
    >
      <p className="eyebrow text-[var(--thoth-warn)]">Awaiting delivery</p>
      <p className="text-sm text-[var(--thoth-stone)] leading-snug">
        Your {decision} decision on{" "}
        <span className="font-mono text-xs">{checkpoint.kind}</span> was
        recorded but couldn&apos;t reach the worker. Auto-retry runs every
        minute, or retry now.
      </p>
      <CheckpointRetryButton runId={runId} checkpointId={checkpoint.id} />
    </aside>
  );
}

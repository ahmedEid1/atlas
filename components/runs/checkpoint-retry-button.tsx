"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Manual retry affordance for a "stranded" HumanCheckpoint — i.e. one
 * whose decision was committed (status != PENDING) but whose Phase 2
 * delivery to Trigger.dev failed, leaving `waitToken` set.
 *
 * The cron outbox at trigger/checkpoint-delivery-outbox.ts handles
 * automatic recovery every minute; this button just lets the user
 * trigger immediate retry from the run page without waiting.
 *
 * Server never ships the raw waitToken — the parent server component
 * derives an `awaitingDelivery: boolean` and renders this component
 * only when true.
 */
export function CheckpointRetryButton({
  runId,
  checkpointId,
}: {
  runId: string;
  checkpointId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/runs/${runId}/checkpoints/${checkpointId}/retry-delivery`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        outcome?: "delivered" | "already_delivered";
        error?: string;
        message?: string;
      };

      if (res.ok && body.ok) {
        // Success — refresh server state so the stranded card disappears.
        router.refresh();
        return;
      }

      let message: string;
      switch (res.status) {
        case 401:
          message = "Your session expired. Please sign in again.";
          break;
        case 403:
          message =
            body.message ??
            "Guest demo accounts can't retry delivery — sign up for a real account.";
          break;
        case 404:
          message = "Checkpoint not found.";
          break;
        case 409:
          message =
            body.message ??
            "This checkpoint is still pending — use approve or reject.";
          break;
        default:
          message = body.message ?? body.error ?? "Retry failed.";
      }
      setError(message);
      setBusy(false);
    } catch {
      setError("Could not reach the server. Check your connection.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={retry}
        disabled={busy}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-[var(--thoth-warn)] text-[var(--thoth-warn)] text-xs font-medium tracking-wide hover:bg-[var(--thoth-warn)]/10 transition-colors disabled:opacity-70 disabled:cursor-progress focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--thoth-blue-ink)]"
      >
        {busy ? (
          <>
            <span
              aria-hidden="true"
              className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
            />
            Retrying…
          </>
        ) : (
          "Retry now"
        )}
      </button>
      {error && (
        <p
          role="alert"
          aria-live="polite"
          className="text-xs text-[var(--thoth-warn)] leading-snug"
        >
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type IncludedPaper = {
  corpusItemId: string;
  relevanceScore: number;
  inclusionReason: string;
};

export function PapersApprovalCard({
  runId,
  checkpointId,
  proposed,
}: {
  runId: string;
  checkpointId: string;
  proposed: IncludedPaper[];
}) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(proposed.map((p) => p.corpusItemId)),
  );
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Same error-mapping pattern as plan-approval-card.tsx — without it, a
  // failed approval would silently `router.refresh()` and the user would see
  // the same card reappear with no explanation.
  async function readError(res: Response): Promise<string> {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    switch (res.status) {
      case 401: return "Your session expired. Please sign in again.";
      case 403: return body.message ?? "You don't have permission to act on this checkpoint.";
      case 404: return "Checkpoint not found — it may have already been processed.";
      case 409: return body.message ?? "Checkpoint already decided — refresh to see the current state.";
      default: return body.message ?? body.error ?? `Action failed (HTTP ${res.status}).`;
    }
  }

  function approve() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/checkpoints/${checkpointId}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ corpusItemIds: [...selected] }),
        });
        if (!res.ok) { setError(await readError(res)); return; }
        router.refresh();
      } catch {
        setError("Could not reach the server. Check your connection.");
      }
    });
  }

  function reject() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/checkpoints/${checkpointId}/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "User aborted at papers gate" }),
        });
        if (!res.ok) { setError(await readError(res)); return; }
        router.refresh();
      } catch {
        setError("Could not reach the server. Check your connection.");
      }
    });
  }

  return (
    <Card className="p-5 space-y-4 border-primary">
      <div>
        <h3 className="text-lg font-semibold">Approve included papers</h3>
        <p className="text-sm text-muted-foreground">
          The retriever scored each corpus item. Uncheck any you don&apos;t want included. {selected.size} of {proposed.length} selected.
        </p>
      </div>

      {proposed.length > 1 && (
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setSelected(new Set(proposed.map((p) => p.corpusItemId)))}
            disabled={isPending || selected.size === proposed.length}
            className="text-[var(--thoth-blue)] hover:underline disabled:opacity-40 disabled:no-underline"
          >
            Select all
          </button>
          <span className="text-muted-foreground">·</span>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            disabled={isPending || selected.size === 0}
            className="text-[var(--thoth-blue)] hover:underline disabled:opacity-40 disabled:no-underline"
          >
            Select none
          </button>
        </div>
      )}

      <ul className="space-y-2 text-sm">
        {proposed.map((p) => (
          <li key={p.corpusItemId} className="flex items-start gap-3 rounded border p-3">
            <input
              type="checkbox"
              checked={selected.has(p.corpusItemId)}
              onChange={() => toggle(p.corpusItemId)}
              className="mt-1"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs">{p.corpusItemId}</span>
                <span className="text-xs text-muted-foreground">score {p.relevanceScore.toFixed(2)}</span>
              </div>
              <p className="text-muted-foreground mt-1">{p.inclusionReason}</p>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={reject} disabled={isPending}>
          Reject all
        </Button>
        <Button onClick={approve} disabled={isPending || selected.size === 0}>
          {isPending ? "Approving…" : `Approve ${selected.size}`}
        </Button>
      </div>
      {error && (
        <p role="alert" aria-live="polite" className="text-destructive text-xs leading-snug">
          {error}
        </p>
      )}
    </Card>
  );
}

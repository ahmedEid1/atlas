"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Small destructive affordance on the project page's run list.
 *
 * Click → confirm dialog → DELETE /api/runs/<id> → router.refresh().
 * The page is a server component, so router.refresh() re-fetches the run
 * list without a full reload.
 *
 * SECURITY: the inner `confirm()` is UX friction, not a security boundary
 * — the API enforces ownership server-side. Without confirm, the
 * destructive op is too easy to fire by accident (it cascades to every
 * step/checkpoint/includedPaper/etc).
 */
export function DeleteRunButton({ runId, runLabel }: { runId: string; runLabel: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Delete this run from ${runLabel}? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}`, { method: "DELETE" });
      if (res.status === 204) {
        router.refresh();
        return;
      }
      if (res.status === 404) {
        setError("Run not found.");
        return;
      }
      if (res.status === 401) {
        setError("Sign in to delete.");
        return;
      }
      setError(`Delete failed (${res.status})`);
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
        aria-label={`Delete run from ${runLabel}`}
      >
        {busy ? "Deleting…" : "Delete"}
      </button>
    </span>
  );
}

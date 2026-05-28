"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Small destructive affordance per row in the dashboard project list.
 *
 * Mirrors `DeleteRunButton` — click → `confirm()` → DELETE /api/projects/<id>
 * → router.refresh(). The page is a server component, so router.refresh()
 * re-fetches the list without a full reload.
 *
 * Project deletion cascades to every CorpusItem, Run, HumanCheckpoint,
 * IncludedPaper, ExtractedClaim, ClaimCheck, DiscoveredPaper,
 * ScreeningDecision owned by the project — the destructive blast radius
 * justifies the confirm() friction even on a small per-row button.
 */
export function DeleteProjectButton({
  projectId,
  projectTitle,
}: {
  projectId: string;
  projectTitle: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (
      !window.confirm(
        `Delete "${projectTitle}"? This deletes every run, paper, claim, and check. Cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      if (res.status === 204) {
        router.refresh();
        return;
      }
      if (res.status === 404) {
        setError("Project not found.");
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
        className="text-xs text-[var(--thoth-stone)] hover:text-destructive disabled:opacity-50 opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label={`Delete project ${projectTitle}`}
      >
        {busy ? "Deleting…" : "Delete"}
      </button>
    </span>
  );
}

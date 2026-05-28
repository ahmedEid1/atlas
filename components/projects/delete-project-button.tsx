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
  /**
   * "list" — the dashboard row variant: hover-revealed link styling +
   *   router.refresh() on success (the row disappears from the
   *   refreshed query).
   * "page" — the project-detail header variant: always visible +
   *   navigates to /dashboard on success (otherwise the user is left
   *   on a page that now 404s).
   */
  variant = "list",
}: {
  projectId: string;
  projectTitle: string;
  variant?: "list" | "page";
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
        if (variant === "page") {
          router.push("/dashboard");
        } else {
          router.refresh();
        }
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

  // `list` variant: the existing dashboard styling (hover-revealed
  // link). `page` variant: an always-visible button suitable for the
  // project header bar.
  const buttonClass =
    variant === "list"
      ? "text-xs text-[var(--thoth-stone)] hover:text-destructive disabled:opacity-50 opacity-0 group-hover:opacity-100 transition-opacity"
      : "text-sm text-muted-foreground hover:text-destructive disabled:opacity-50 px-3 py-1.5 rounded border border-input hover:border-destructive transition-colors";

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className={buttonClass}
        aria-label={`Delete project ${projectTitle}`}
      >
        {busy ? "Deleting…" : "Delete"}
      </button>
    </span>
  );
}

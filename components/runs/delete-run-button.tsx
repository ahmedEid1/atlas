"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Small destructive affordance to delete a Run.
 *
 * `variant`:
 *   - `"list"` (default) — used in the project page's runs list;
 *     `router.refresh()` on success (the row disappears).
 *   - `"page"` — used on the run-detail page; navigates to the
 *     project page on success (otherwise the user is left on a
 *     page that 404s) + larger, always-visible styling.
 *
 * SECURITY: the inner `confirm()` is UX friction, not a security
 * boundary — the API enforces ownership server-side. Without
 * confirm, the destructive op is too easy to fire by accident
 * (it cascades to every step / checkpoint / includedPaper / etc).
 */
export function DeleteRunButton({
  runId,
  runLabel,
  variant = "list",
  redirectTo,
}: {
  runId: string;
  runLabel: string;
  variant?: "list" | "page";
  redirectTo?: string;
}) {
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
        if (variant === "page" && redirectTo) {
          router.push(redirectTo);
        } else {
          router.refresh();
        }
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

  const buttonClass =
    variant === "list"
      ? "text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
      : "text-sm text-muted-foreground hover:text-destructive disabled:opacity-50 px-3 py-1.5 rounded border border-input hover:border-destructive transition-colors";

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className={buttonClass}
        aria-label={`Delete run from ${runLabel}`}
      >
        {busy ? "Deleting…" : "Delete run"}
      </button>
    </span>
  );
}

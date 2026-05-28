"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type DiscoveredHit = {
  id: string;
  externalId: string;
  provider: "openalex" | "arxiv" | "exa" | string;
  title: string;
  abstract: string | null;
  accessStatus: "open" | "paywalled" | "unknown" | string;
};

type Props = {
  runId: string;
  checkpointId: string;
  queries: string[];
  hits: DiscoveredHit[];
};

const PROVIDER_BADGE: Record<string, string> = {
  openalex: "OpenAlex",
  arxiv: "arXiv",
  exa: "Exa",
  uploaded: "Uploaded",
};

/**
 * V2 — HITL approval for the outbound discoverer.
 *
 * Shows the generated search queries + the deduped hit list (top 50 sorted
 * by the discoverer's initial relevance score). The user can:
 *
 *   - Approve as-is. Every hit passes through the fetcher → screener.
 *   - Drop individual hits via the per-row checkbox. Dropped hits are
 *     submitted as `keptExternalIds` so the agent only fetches the rest.
 *   - Edit the queries + re-run discovery (M113). Posts the edited queries
 *     as `editedQueries` with `approved:false`; the graph routes back to the
 *     discoverer, which replaces the discovered set and re-fires this gate.
 *   - Reject the whole sweep with a reason — the run ends without burning
 *     OCR / screener LLM calls.
 */
export function DiscoveryApprovalCard({ runId, checkpointId, queries, hits }: Props) {
  const router = useRouter();
  const [kept, setKept] = useState<Set<string>>(
    new Set(hits.map((h) => h.externalId)),
  );
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [editQueries, setEditQueries] = useState<string[]>(queries);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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

  function toggle(externalId: string) {
    setKept((s) => {
      const next = new Set(s);
      if (next.has(externalId)) next.delete(externalId);
      else next.add(externalId);
      return next;
    });
  }

  function approve() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/checkpoints/${checkpointId}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keptExternalIds: [...kept] }),
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
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: rejectReason || "Discovered hits not relevant" }),
        });
        if (!res.ok) { setError(await readError(res)); return; }
        router.refresh();
      } catch {
        setError("Could not reach the server. Check your connection.");
      }
    });
  }

  function rerun() {
    setError(null);
    // Trim + drop blank rows here too (the discoverer does the same), so the
    // disabled-button guard and what we POST agree.
    const cleaned = editQueries.map((q) => q.trim()).filter((q) => q.length > 0);
    if (cleaned.length === 0) {
      setError("Add at least one search query to re-run discovery.");
      return;
    }
    startTransition(async () => {
      try {
        // Posts to the same approve endpoint; `approved:false` + editedQueries
        // is the re-run signal (the route spreads body over {approved:true},
        // so body wins). The graph routes back to the discoverer.
        const res = await fetch(`/api/runs/${runId}/checkpoints/${checkpointId}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approved: false, editedQueries: cleaned }),
        });
        if (!res.ok) { setError(await readError(res)); return; }
        router.refresh();
      } catch {
        setError("Could not reach the server. Check your connection.");
      }
    });
  }

  const openCount = hits.filter((h) => h.accessStatus === "open").length;

  return (
    <Card className="p-5 space-y-4 border-primary">
      <div>
        <h2 className="text-lg font-semibold">Review discovered papers</h2>
        <p className="text-sm text-muted-foreground">
          The discoverer ran {queries.length} {queries.length === 1 ? "query" : "queries"} across your
          enabled providers and found {hits.length} unique {hits.length === 1 ? "paper" : "papers"}{" "}
          ({openCount} open-access). Uncheck any you don&apos;t want fetched + screened, then approve.
        </p>
      </div>

      <section>
        <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
          <h3 className="text-sm font-medium">Search queries</h3>
          {!editing && !showReject && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                // Seed the editor with the current queries (or one blank row
                // if the discoverer somehow returned none).
                setEditQueries(queries.length > 0 ? queries : [""]);
                setEditing(true);
              }}
              disabled={isPending}
              className="text-xs text-[var(--thoth-blue)] hover:underline disabled:opacity-40 disabled:no-underline"
            >
              Edit &amp; re-run
            </button>
          )}
        </div>
        {editing ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Edit the queries, then re-run discovery. This replaces the current hits
              with a fresh search — nothing has been fetched or screened yet.
            </p>
            <ul className="space-y-2">
              {editQueries.map((q, i) => (
                <li key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={q}
                    onChange={(e) =>
                      setEditQueries((qs) => qs.map((x, j) => (j === i ? e.target.value : x)))
                    }
                    className="flex-1 text-sm border rounded p-2 font-mono"
                    placeholder="Search query"
                    aria-label={`Query ${i + 1}`}
                    disabled={isPending}
                  />
                  <button
                    type="button"
                    onClick={() => setEditQueries((qs) => qs.filter((_, j) => j !== i))}
                    disabled={isPending || editQueries.length === 1}
                    className="text-muted-foreground hover:text-destructive disabled:opacity-30 text-lg leading-none px-2"
                    aria-label={`Remove query ${i + 1}`}
                    title="Remove this query"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setEditQueries((qs) => [...qs, ""])}
              disabled={isPending}
              className="text-xs text-[var(--thoth-blue)] hover:underline disabled:opacity-40 disabled:no-underline"
            >
              + Add query
            </button>
            <div className="flex gap-2 justify-end pt-1">
              <Button
                variant="outline"
                onClick={() => {
                  setEditing(false);
                  setError(null);
                }}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={rerun}
                disabled={isPending || editQueries.every((q) => q.trim().length === 0)}
              >
                {isPending ? "Re-running…" : "Re-run discovery"}
              </Button>
            </div>
          </div>
        ) : (
          <ul className="text-xs space-y-1 list-disc pl-5 text-muted-foreground">
            {queries.map((q, i) => (
              <li key={i} className="font-mono">{q}</li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
          <h3 className="text-sm font-medium">Hits ({kept.size} of {hits.length} kept)</h3>
          {hits.length > 1 && (
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => setKept(new Set(hits.map((h) => h.externalId)))}
                disabled={isPending || kept.size === hits.length}
                className="text-[var(--thoth-blue)] hover:underline disabled:opacity-40 disabled:no-underline"
              >
                Select all
              </button>
              <span className="text-muted-foreground">·</span>
              <button
                type="button"
                onClick={() => setKept(new Set())}
                disabled={isPending || kept.size === 0}
                className="text-[var(--thoth-blue)] hover:underline disabled:opacity-40 disabled:no-underline"
              >
                Select none
              </button>
              {openCount > 0 && openCount < hits.length && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <button
                    type="button"
                    onClick={() =>
                      setKept(
                        new Set(
                          hits
                            .filter((h) => h.accessStatus === "open")
                            .map((h) => h.externalId),
                        ),
                      )
                    }
                    disabled={isPending}
                    className="text-[var(--thoth-blue)] hover:underline disabled:opacity-40 disabled:no-underline"
                    title="Keep only the hits with a known open-access URL — paywalled / unknown PDFs may fail at fetch."
                  >
                    Only open-access ({openCount})
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <ul className="space-y-2 text-sm max-h-96 overflow-y-auto pr-2">
          {hits.map((h) => (
            <li key={h.id} className="flex items-start gap-3 rounded border p-3">
              <input
                type="checkbox"
                checked={kept.has(h.externalId)}
                onChange={() => toggle(h.externalId)}
                className="mt-1"
                aria-label={`Keep ${h.title}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-xs font-mono text-[var(--thoth-blue)] px-1.5 py-0.5 rounded bg-[var(--thoth-blue-mist)]/40">
                    {PROVIDER_BADGE[h.provider] ?? h.provider}
                  </span>
                  <span className="text-xs text-muted-foreground">{h.accessStatus}</span>
                </div>
                <p className="mt-1 text-[var(--thoth-blue-ink)] leading-snug">{h.title}</p>
                {h.abstract && (
                  <p className="mt-1 text-xs text-[var(--thoth-stone)] line-clamp-2">{h.abstract}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {editing ? null : showReject ? (
        <div className="space-y-2">
          <textarea
            placeholder="Why are you rejecting this discovery set? (optional)"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            className="w-full text-sm border rounded p-2"
            rows={2}
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                // Clear the optional reason on Cancel so the user
                // doesn't see their abandoned reject reason when re-
                // opening the reject panel. Matches M70/M71's reset
                // posture; mirrors the PlanApprovalCard change.
                setShowReject(false);
                setRejectReason("");
              }}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={reject} disabled={isPending}>
              {isPending ? "Rejecting…" : "Confirm reject"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 justify-end">
          <Button variant="outline" onClick={() => setShowReject(true)} disabled={isPending}>
            Reject
          </Button>
          <Button onClick={approve} disabled={isPending || kept.size === 0}>
            {isPending ? "Approving…" : `Approve ${kept.size}`}
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" aria-live="polite" className="text-destructive text-xs leading-snug">
          {error}
        </p>
      )}
    </Card>
  );
}

"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SummaryView, type PaperSummary } from "@/components/corpus/summary-view";

type Item = {
  id: string;
  source: string;
  status: "PENDING" | "PARSING" | "PARSED" | "FAILED";
  parsedMarkdown: string | null;
  failureReason: string | null;
  summary: PaperSummary | null;
  summaryTraceUrl: string | null;
  summarisedAt: Date | string | null;
};

/**
 * Compute a friendly display label for a corpus item.
 *
 * Priority:
 *   1. First H1/H2 heading line of `parsedMarkdown` (Mistral OCR puts
 *      the paper title here for almost every PDF — works for uploads
 *      AND for V2 discovered papers once the fetcher has OCR'd them).
 *   2. Humanised `source` fallback:
 *      - uploads (R2 keys: `corpus/<projectId>/<uuid>.pdf`) → just
 *        the filename, no project-path leak.
 *      - `openalex:W123` → "OpenAlex W123"
 *      - `arxiv:2310.06770` → "arXiv 2310.06770"
 *      - `exa:<url>` → "Exa <url>"
 *      - everything else → the source unchanged.
 *
 * Exported for unit testing.
 */
export function corpusItemLabel(item: { source: string; parsedMarkdown: string | null }): string {
  if (item.parsedMarkdown) {
    // First non-empty `# Heading` or `## Heading` line. Trim the `#`s
    // + whitespace; collapse common LaTeX-ish artifacts that Mistral
    // occasionally emits ($\mathrm{...}$ etc) by just taking the raw
    // text and capping length.
    const lines = item.parsedMarkdown.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^#{1,2}\s+(.+)$/);
      const heading = match?.[1]?.trim();
      if (heading && heading.length > 0) {
        return heading.length > 140 ? heading.slice(0, 137) + "…" : heading;
      }
    }
  }
  const s = item.source;
  if (s.startsWith("corpus/")) {
    // R2 key: `corpus/<projectId>/<uuid>.pdf` — last path segment is
    // the safest user-facing handle (project IDs aren't secret per se,
    // but the filename alone reads cleaner in the list).
    const parts = s.split("/");
    return parts[parts.length - 1] || s;
  }
  if (s.startsWith("openalex:")) return `OpenAlex ${s.slice("openalex:".length)}`;
  if (s.startsWith("arxiv:")) return `arXiv ${s.slice("arxiv:".length)}`;
  if (s.startsWith("exa:")) return `Exa ${s.slice("exa:".length)}`;
  return s;
}

const STATUS_VARIANT: Record<Item["status"], "default" | "secondary" | "destructive" | "outline"> = {
  PENDING: "outline",
  PARSING: "secondary",
  PARSED: "default",
  FAILED: "destructive",
};

export function CorpusItemList({ items }: { items: Item[] }) {
  const router = useRouter();

  // Poll while parse pipeline is mid-flight. Pauses when the tab is hidden
  // so a backgrounded upload page doesn't keep firing 2s router.refresh()
  // hits at the Vercel function quota for nothing. Mirrors the visibility
  // logic on the run-detail RefreshTick.
  // (Trigger.dev's realtime SDK could replace the polling entirely; left
  // as polling so far because the parse pipeline finishes in ~30-60s and
  // the realtime subscription needs an auth-token route + JWT plumbing.)
  // Stable signature for the effect dependency: status-string list joined
  // with commas. Without this, `items` is a new array reference on every
  // server-page render (every 2s while polling), so the effect tore down
  // + re-set the interval each tick. The behaviour was correct but the
  // cleanup/re-setup churn was unnecessary.
  const statusSig = items.map((i) => i.status).join(",");
  useEffect(() => {
    const anyParsing = statusSig
      .split(",")
      .some((s) => s === "PENDING" || s === "PARSING");
    if (!anyParsing) return;

    let intervalId: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (intervalId !== undefined) return;
      intervalId = setInterval(() => router.refresh(), 2000);
    };
    const stop = () => {
      if (intervalId === undefined) return;
      clearInterval(intervalId);
      intervalId = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [statusSig, router]);

  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No documents yet. Upload a PDF to get started.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {items.map((it) => (
        <li key={it.id}>
          <ItemCard item={it} />
        </li>
      ))}
    </ul>
  );
}

function ItemCard({ item }: { item: Item }) {
  const [markdownOpen, setMarkdownOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(Boolean(item.summary));
  const [isPending, startTransition] = useTransition();
  const [summariseError, setSummariseError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const router = useRouter();

  async function deleteItem() {
    // The cascade is consequential: any IncludedPaper / ExtractedClaim /
    // ClaimCheck rows that reference this corpus item will be deleted
    // alongside it. Spell that out in the confirm() so the user can't
    // delete a paper that's cited in a completed review without knowing.
    if (
      !window.confirm(
        `Delete "${item.source}"?\n\nIf any review run included this paper, its included-paper + extracted-claim rows will be deleted with it. The review draft itself is preserved.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/corpus/${item.id}`, { method: "DELETE" });
      if (res.status === 204) {
        router.refresh();
        return;
      }
      if (res.status === 404) {
        setDeleteError("Item not found.");
        return;
      }
      if (res.status === 401) {
        setDeleteError("Sign in to delete.");
        return;
      }
      setDeleteError(`Delete failed (${res.status})`);
    } catch {
      setDeleteError("Network error.");
    } finally {
      setDeleting(false);
    }
  }

  function summarise() {
    setSummariseError(null);
    startTransition(async () => {
      const res = await fetch(`/api/corpus/${item.id}/summarize`, { method: "POST" });
      if (!res.ok) {
        // The route returns one of two shapes (see /api/corpus/[id]/summarize/route.ts):
        //   - 409: { error: "Corpus item is parsing, not yet PARSED" }  (error IS the message)
        //   - 502: { error: "summarize_enqueue_failed", message: "Could not start…" }
        // Prefer `message` when present (the human-readable copy) so the user
        // doesn't see the raw error code on a Trigger.dev outage.
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setSummariseError(body.message ?? body.error ?? `Failed (${res.status})`);
        return;
      }
      // Wait briefly then refresh so the new summary is read from the server
      // component once the Trigger.dev `summarize-paper` task finishes. 3s is
      // empirically enough on the free tier; the next list-level poll will
      // catch up if it isn't.
      setTimeout(() => router.refresh(), 3000);
    });
  }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-sm truncate" title={item.source}>
            {corpusItemLabel(item)}
          </p>
          <p className="font-mono text-[10px] text-muted-foreground truncate mt-0.5">
            {item.source}
          </p>
          {item.failureReason && (
            <p className="text-destructive text-xs mt-1">{item.failureReason}</p>
          )}
          {summariseError && (
            <p className="text-destructive text-xs mt-1">{summariseError}</p>
          )}
          {deleteError && (
            <p className="text-destructive text-xs mt-1">{deleteError}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={STATUS_VARIANT[item.status]}>{item.status.toLowerCase()}</Badge>
          {item.status === "PARSED" && (
            <>
              {item.parsedMarkdown && (
                <button
                  className="text-sm underline"
                  onClick={() => setMarkdownOpen((v) => !v)}
                >
                  {markdownOpen ? "Hide markdown" : "Markdown"}
                </button>
              )}
              {!item.summary && (
                <Button onClick={summarise} disabled={isPending}>
                  {isPending ? "Summarising…" : "Summarise"}
                </Button>
              )}
              {item.summary && (
                <button
                  className="text-sm underline"
                  onClick={() => setSummaryOpen((v) => !v)}
                >
                  {summaryOpen ? "Hide summary" : "Summary"}
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={deleteItem}
            disabled={deleting}
            className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
            aria-label={`Delete corpus item ${item.source}`}
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      {markdownOpen && item.parsedMarkdown && (
        <pre className="mt-4 max-h-96 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
          {item.parsedMarkdown}
        </pre>
      )}

      {summaryOpen && item.summary && (
        <SummaryView summary={item.summary} traceUrl={item.summaryTraceUrl} />
      )}
    </Card>
  );
}

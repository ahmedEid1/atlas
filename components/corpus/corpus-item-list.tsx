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
  useEffect(() => {
    const anyParsing = items.some(
      (i) => i.status === "PENDING" || i.status === "PARSING",
    );
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
  }, [items, router]);

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
  const router = useRouter();

  function summarise() {
    setSummariseError(null);
    startTransition(async () => {
      const res = await fetch(`/api/corpus/${item.id}/summarize`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSummariseError(body.error ?? `Failed (${res.status})`);
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
          <p className="font-mono text-xs truncate">{item.source}</p>
          {item.failureReason && (
            <p className="text-destructive text-xs mt-1">{item.failureReason}</p>
          )}
          {summariseError && (
            <p className="text-destructive text-xs mt-1">{summariseError}</p>
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

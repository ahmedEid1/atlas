import { Card } from "@/components/ui/card";

type DiscoveredPaper = {
  id: string;
  provider: string;
  externalId: string;
  title: string;
  authors: string[];
  publicationYear: number | null;
  initialScore: number;
  corpusItemId: string | null;
  screening: {
    include: boolean;
    relevanceScore: number;
    reason: string;
  } | null;
};

type ProviderError = {
  nodeName: string;
  failureReason: string;
};

type Props = {
  queries: string[];
  discoveredPapers: DiscoveredPaper[];
  providerErrors: ProviderError[];
};

const PROVIDER_BADGE: Record<string, string> = {
  openalex: "OpenAlex",
  arxiv: "arXiv",
  exa: "Exa",
  uploaded: "Uploaded",
};

/**
 * V2 — server-component summary of the outbound discoverer + screener output.
 * Renders on the run-detail page for outbound/hybrid runs, both in-flight
 * (queries visible as soon as the discoverer step finishes) and after
 * completion (full screening verdicts visible).
 *
 * This is the page-level view of what the `list_discovered_papers` +
 * `get_search_queries` MCP tools return. Showing the same data inline
 * means the user doesn't need an MCP client to see what the agent did.
 */
export function DiscoverySummary({ queries, discoveredPapers, providerErrors }: Props) {
  const totalDiscovered = discoveredPapers.length;
  const totalFetched = discoveredPapers.filter((p) => p.corpusItemId !== null).length;
  const screenedIn = discoveredPapers.filter((p) => p.screening?.include === true).length;
  const screenedOut = discoveredPapers.filter((p) => p.screening?.include === false).length;
  const stillToScreen = discoveredPapers.filter((p) => p.screening === null).length;

  return (
    <Card className="p-5 space-y-4">
      <header>
        <h2 className="text-lg font-medium">Discovery</h2>
        <p className="text-xs text-muted-foreground">
          {queries.length} {queries.length === 1 ? "query" : "queries"} ran across the project&apos;s configured providers.
          {totalDiscovered > 0 && (
            <>
              {" "}Surfaced <strong>{totalDiscovered}</strong> unique{" "}
              {totalDiscovered === 1 ? "paper" : "papers"}
              {totalFetched > 0 && ` (${totalFetched} fetched + OCR'd)`}.
            </>
          )}
        </p>
        {totalDiscovered > 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            Screening: <span className="text-emerald-700">{screenedIn} included</span>{" "}·{" "}
            <span className="text-muted-foreground">{screenedOut} excluded</span>
            {stillToScreen > 0 && (
              <> · <span className="italic">{stillToScreen} not yet screened</span></>
            )}
          </p>
        )}
      </header>

      {queries.length > 0 && (
        <section>
          <h3 className="text-sm font-medium mb-1.5">Search queries</h3>
          <ul className="text-xs space-y-1 list-disc pl-5 text-muted-foreground">
            {queries.map((q, i) => (
              <li key={i} className="font-mono">{q}</li>
            ))}
          </ul>
        </section>
      )}

      {providerErrors.length > 0 && (
        <section className="rounded border border-amber-300 bg-amber-50/60 p-3 text-xs space-y-1">
          <h3 className="font-medium text-amber-900">Partial provider failures</h3>
          <ul className="space-y-0.5 text-amber-900/80">
            {providerErrors.map((e, i) => (
              <li key={i}>
                <span className="font-mono">{e.nodeName}</span>: {e.failureReason}
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-amber-900/70 mt-1">
            The discoverer continues with the surviving providers — these errors don&apos;t
            fail the run on their own.
          </p>
        </section>
      )}

      {discoveredPapers.length > 0 && (
        <section>
          <h3 className="text-sm font-medium mb-1.5">Discovered papers</h3>
          <ul className="space-y-1.5 text-sm max-h-96 overflow-y-auto pr-2">
            {discoveredPapers.map((p) => (
              <li
                key={p.id}
                className={`rounded border p-2.5 text-xs ${
                  p.screening?.include ? "border-emerald-300 bg-emerald-50/40" : ""
                }`}
              >
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-mono text-[10px] text-[var(--thoth-blue)] px-1 rounded bg-[var(--thoth-blue-mist)]/40">
                    {PROVIDER_BADGE[p.provider] ?? p.provider}
                  </span>
                  {p.publicationYear && (
                    <span className="text-muted-foreground">{p.publicationYear}</span>
                  )}
                  <span className="text-muted-foreground">
                    score {p.initialScore.toFixed(2)}
                  </span>
                  {p.corpusItemId && (
                    <span className="text-emerald-700">fetched</span>
                  )}
                  {p.screening?.include === true && (
                    <span className="text-emerald-700 font-medium">included</span>
                  )}
                  {p.screening?.include === false && (
                    <span className="text-muted-foreground">excluded</span>
                  )}
                </div>
                <p className="mt-1 text-[var(--thoth-blue-ink)] leading-snug line-clamp-2">
                  {p.title}
                </p>
                {p.screening && (
                  <p className="mt-1 text-[10px] text-muted-foreground line-clamp-2 italic">
                    {p.screening.reason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Card>
  );
}

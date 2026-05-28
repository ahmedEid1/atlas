import type { SearchProvider, DiscoveredPaperSpec } from "@/lib/search/types";
import { SearchProviderError } from "@/lib/search/types";

/**
 * Exa adapter — semantic search via embeddings.
 *
 * Free tier: 1000 searches/month. Requires `EXA_API_KEY` env var; the
 * adapter throws SearchProviderError("exa", "missing API key") if unset,
 * which the dispatcher records per-provider without killing the run.
 *
 * Docs: https://docs.exa.ai/reference/search
 *
 * We pass `type: "neural"` to force the semantic-embedding mode (vs.
 * "auto" or "keyword") and include `contents: { text: true }` so the
 * screener has body text without a second round-trip. Year filtering
 * uses Exa's startPublishedDate / endPublishedDate parameters.
 *
 * Score normalization: Exa returns a relevance score in [0, 1] already,
 * so we pass it through unmodified (other providers we max-normalize).
 */
export const exaSearch: SearchProvider = async (q) => {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    throw new SearchProviderError(
      "exa",
      "missing API key (set EXA_API_KEY)",
    );
  }

  const body: Record<string, unknown> = {
    query: q.query,
    type: "neural",
    numResults: Math.min(q.limit ?? 25, 50),
    // Ask Exa to bundle the text body so the screener doesn't need a
    // separate `contents` call. Exa's pricing is per-request, not per
    // result, so this is free.
    contents: { text: { maxCharacters: 4000 } },
  };
  if (q.yearStart !== undefined) {
    body.startPublishedDate = `${q.yearStart}-01-01`;
  }
  if (q.yearEnd !== undefined) {
    body.endPublishedDate = `${q.yearEnd}-12-31`;
  }

  let response: Response;
  try {
    response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new SearchProviderError(
      "exa",
      `network error: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  if (!response.ok) {
    throw new SearchProviderError(
      "exa",
      `HTTP ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as {
    results?: Array<{
      id?: string;
      url?: string;
      title?: string;
      score?: number;
      publishedDate?: string | null;
      author?: string | null;
      text?: string | null;
    }>;
  };

  const results = json.results ?? [];
  return results
    .map((r): DiscoveredPaperSpec | null => {
      if (!r.title || !r.url) return null;
      // Exa returns free-form crawled dates, not guaranteed ISO — a non-numeric
      // prefix (e.g. "Spring 2023") makes parseInt return NaN. Guard it:
      // NaN would flow to publicationYear and crash the discoverer's createMany
      // (Prisma rejects NaN for the Int? column), failing the whole run.
      const parsedYear =
        typeof r.publishedDate === "string" && r.publishedDate.length >= 4
          ? parseInt(r.publishedDate.slice(0, 4), 10)
          : null;
      const year = parsedYear !== null && Number.isFinite(parsedYear) ? parsedYear : null;
      const authors =
        typeof r.author === "string" && r.author.length > 0
          ? r.author
              .split(/[,;]/)
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      // Exa returns the URL of the published page (not necessarily a PDF).
      // Most of the time it's a publisher landing page rather than an OA
      // PDF — declare accessStatus=unknown unless the URL ends in .pdf.
      const isPdf = /\.pdf($|\?)/i.test(r.url);
      const accessStatus: DiscoveredPaperSpec["accessStatus"] = isPdf
        ? "open"
        : "unknown";
      return {
        provider: "exa",
        // Exa doesn't expose DOIs; use the canonical URL hashed via the
        // provider id. The dispatcher's dedup-by-externalId still works
        // when OpenAlex/arXiv emit the DOI for the same paper because we
        // prefer the higher-scored copy.
        externalId: r.url,
        title: r.title,
        authors,
        abstract: r.text && r.text.length > 0 ? r.text.slice(0, 2000) : null,
        publicationYear: year,
        venue: null,
        citationCount: null,
        oaUrl: isPdf ? r.url : null,
        accessStatus,
        initialScore:
          typeof r.score === "number"
            ? Math.max(0, Math.min(1, r.score))
            : 0.5,
      };
    })
    .filter((x): x is DiscoveredPaperSpec => x !== null);
};

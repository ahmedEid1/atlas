import type { SearchProvider, DiscoveredPaperSpec } from "@/lib/search/types";
import { SearchProviderError } from "@/lib/search/types";

/**
 * arXiv adapter — preprints with always-OA PDFs.
 *
 * Free. Polite rate limit: ~3 seconds between calls per arXiv's guidance.
 * The dispatcher fans out in parallel, but consumers calling this in a
 * tight loop should self-pace. No auth.
 *
 * Docs: https://info.arxiv.org/help/api/index.html (Atom XML response).
 *
 * The response is stable XML. We parse with targeted regex rather than a
 * full XML library because the fields we need are flat under `<entry>` and
 * adding a dep for one provider isn't worth it. The patterns below match
 * arXiv's exact tag form (no attributes, no namespace prefixes that vary).
 */
export const arxivSearch: SearchProvider = async (q) => {
  const params = new URLSearchParams();
  // Free-text search across title + abstract. arXiv also supports `ti:`,
  // `abs:`, `au:`, `cat:` prefixes; we pass the natural query through and
  // let the discoverer's prompt generate provider-specific terms.
  params.set("search_query", `all:${q.query}`);
  params.set("start", "0");
  params.set("max_results", String(Math.min(q.limit ?? 25, 50)));
  params.set("sortBy", "relevance");
  params.set("sortOrder", "descending");

  const url = `https://export.arxiv.org/api/query?${params.toString()}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/atom+xml" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new SearchProviderError(
      "arxiv",
      `network error: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  if (!response.ok) {
    throw new SearchProviderError(
      "arxiv",
      `HTTP ${response.status} ${response.statusText}`,
    );
  }

  const xml = await response.text();
  return parseArxivAtom(xml, { yearStart: q.yearStart, yearEnd: q.yearEnd });
};

/**
 * Parse the arXiv Atom feed into normalized hits.
 *
 * Exported for direct unit tests against canned XML fixtures. The provider
 * function above is the integration surface; this is the pure transform.
 *
 * `yearStart`/`yearEnd` are applied client-side because arXiv's search API
 * doesn't expose a year filter on the `search_query` syntax (only on the
 * deprecated `prune-by-date` endpoint).
 */
export function parseArxivAtom(
  xml: string,
  filters: { yearStart?: number; yearEnd?: number } = {},
): DiscoveredPaperSpec[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  const hits: DiscoveredPaperSpec[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const idUrl = pickFirst(entry, /<id>([^<]+)<\/id>/);
    if (!idUrl) continue;
    // arXiv ids look like `http://arxiv.org/abs/2310.06770v1` — strip the
    // version suffix so we dedup across `v1`/`v2`/etc.
    const arxivIdMatch = idUrl.match(/abs\/([^/]+?)(?:v\d+)?$/);
    if (!arxivIdMatch) continue;
    const arxivId = arxivIdMatch[1]!;

    const title = pickFirst(entry, /<title>([\s\S]*?)<\/title>/)?.trim();
    if (!title) continue;

    const summary = pickFirst(entry, /<summary>([\s\S]*?)<\/summary>/)?.trim();

    const published = pickFirst(entry, /<published>([^<]+)<\/published>/);
    const parsedYear = published ? parseInt(published.slice(0, 4), 10) : null;
    // Guard NaN (a malformed <published> would otherwise flow to the Int?
    // column and crash the discoverer's createMany). arXiv emits ISO dates so
    // this is defensive, but it keeps the parse identical to the exa adapter.
    const publicationYear =
      parsedYear !== null && Number.isFinite(parsedYear) ? parsedYear : null;
    if (publicationYear !== null) {
      if (filters.yearStart !== undefined && publicationYear < filters.yearStart) continue;
      if (filters.yearEnd !== undefined && publicationYear > filters.yearEnd) continue;
    }

    const authors: string[] = [];
    const authorBlocks = entry.match(/<author>[\s\S]*?<\/author>/g) ?? [];
    for (const block of authorBlocks) {
      const name = pickFirst(block, /<name>([^<]+)<\/name>/);
      if (name) authors.push(name.trim());
    }

    // <link ... type="application/pdf" ... href="..."> when present.
    // Attribute order is unstable across arXiv responses (sometimes href
    // first, sometimes type first), so scan every <link> tag and pick the
    // one with type=application/pdf. Falls back to the canonical pattern
    // when no PDF link is exposed (the canonical URL always 301s to the
    // latest version, so it stays correct).
    const linkTags = entry.match(/<link[^>]+\/?>/g) ?? [];
    let oaUrl: string | undefined;
    for (const lt of linkTags) {
      if (/type="application\/pdf"/.test(lt)) {
        const href = lt.match(/href="([^"]+)"/);
        if (href) {
          oaUrl = href[1];
          break;
        }
      }
    }
    if (!oaUrl) oaUrl = `https://arxiv.org/pdf/${arxivId}`;
    // Normalize to https.
    oaUrl = oaUrl.replace(/^http:\/\//, "https://");

    // Optional DOI tag for the published-version cross-reference. The
    // namespace declaration may live on the opening tag itself
    // (`<arxiv:doi xmlns:arxiv="...">`) when the feed inlines namespaces
    // per-entry instead of on the root <feed>, so the regex allows
    // arbitrary attributes between the tag name and `>`.
    const doi = pickFirst(entry, /<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/);
    // External id: prefer DOI when arXiv knows it (lets us dedup against
    // OpenAlex hits); else `arxiv:<id>`.
    const externalId = doi && doi.length > 0 ? doi : `arxiv:${arxivId}`;

    // arXiv doesn't return a relevance score; we use 1 / (rank + 1) so the
    // first hit scores 1.0 and they degrade. Capped at 50 hits per query so
    // the bottom score is ~0.02.
    const initialScore = 1 / (i + 1);

    hits.push({
      provider: "arxiv",
      externalId,
      title: title.replace(/\s+/g, " "),
      authors,
      abstract: summary ? summary.replace(/\s+/g, " ") : null,
      publicationYear,
      venue: "arXiv",
      citationCount: null, // arXiv API doesn't expose citation counts
      oaUrl,
      accessStatus: "open", // every arXiv submission is OA by definition
      initialScore,
    });
  }

  return hits;
}

function pickFirst(haystack: string, re: RegExp): string | undefined {
  const m = haystack.match(re);
  return m ? m[1] : undefined;
}

/**
 * V2 outbound-search provider interface.
 *
 * Each search adapter (OpenAlex / arXiv / Exa) implements `searchProvider`
 * returning a normalized `DiscoveredPaperSpec[]`. The dispatcher
 * (`lib/search/dispatch.ts`) calls every adapter in parallel, deduplicates
 * by canonical id, and hands the result to the discoverer agent node.
 *
 * Spec: docs/superpowers/specs/thoth-v2-design.md §4
 */

import { z } from "zod";

/** Allowed provider names; mirrors the `searchProviders` column on Project. */
export type SearchProviderName = "openalex" | "arxiv" | "exa";

/**
 * One normalized search hit. The schema is the **input contract** for
 * `db.discoveredPaper.create` after the dispatcher dedupes — fields map
 * 1:1 to columns. Fields that the provider can't return are `null`
 * rather than missing so the screener has a consistent shape to score.
 */
export const DiscoveredPaperSpecSchema = z.object({
  provider: z.enum(["openalex", "arxiv", "exa"]),
  /** Canonical id used for dedup. DOI when known; else `arxiv:<id>`, `openalex:<W…>`. */
  externalId: z.string().min(1),
  title: z.string().min(1),
  authors: z.array(z.string()),
  abstract: z.string().nullable(),
  publicationYear: z.number().int().min(1800).max(2100).nullable(),
  venue: z.string().nullable(),
  citationCount: z.number().int().nonnegative().nullable(),
  /** Direct PDF URL when the provider knows of an open-access copy. */
  oaUrl: z.string().url().nullable(),
  /** "open" | "paywalled" | "unknown" — drives the fetcher node's decision to download. */
  accessStatus: z.enum(["open", "paywalled", "unknown"]),
  /** Provider-supplied relevance heuristic in [0, 1]. */
  initialScore: z.number().min(0).max(1),
});

export type DiscoveredPaperSpec = z.infer<typeof DiscoveredPaperSpecSchema>;

/** Input to a search call: the natural-language query + optional filters. */
export type SearchQuery = {
  query: string;
  yearStart?: number;
  yearEnd?: number;
  /** Hard cap on hits the provider should return. The dispatcher will further trim. */
  limit?: number;
};

/** A single search adapter — one function per provider. */
export type SearchProvider = (q: SearchQuery) => Promise<DiscoveredPaperSpec[]>;

/**
 * Thrown by an adapter when the provider returns a transient error
 * (rate-limit / 5xx / timeout). The dispatcher catches and records the
 * failure per-provider so the run can continue with the other providers.
 */
export class SearchProviderError extends Error {
  constructor(
    public readonly provider: SearchProviderName,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "SearchProviderError";
  }
}

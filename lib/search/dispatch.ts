import type {
  DiscoveredPaperSpec,
  SearchProvider,
  SearchProviderName,
  SearchQuery,
} from "@/lib/search/types";
import { SearchProviderError } from "@/lib/search/types";
import { openalexSearch } from "@/lib/search/providers/openalex";
import { arxivSearch } from "@/lib/search/providers/arxiv";
import { exaSearch } from "@/lib/search/providers/exa";

/**
 * Provider registry. The `provider` field on `DiscoveredPaperSpec` maps 1:1
 * to a key here, so a row in `DiscoveredPaper` can always be regenerated
 * (no hidden provider state).
 */
const REGISTRY: Record<SearchProviderName, SearchProvider> = {
  openalex: openalexSearch,
  arxiv: arxivSearch,
  exa: exaSearch,
};

export type DispatchResult = {
  hits: DiscoveredPaperSpec[];
  /** Per-provider error messages (empty array if every provider succeeded). */
  errors: Array<{ provider: SearchProviderName; message: string }>;
};

/**
 * Fan out a query to every enabled provider, deduplicate by canonical id,
 * and return both the merged hit list and the per-provider error log.
 *
 * Provider failure is **non-fatal**: a 5xx from one provider records an
 * error entry and the run continues with whatever the other providers
 * returned. The discoverer node decides whether the survivor set is
 * enough to proceed.
 *
 * Dedup precedence: when the same paper is returned by multiple providers,
 * keep the highest `initialScore`. (Tie → first encountered.) OpenAlex
 * tends to have the richest metadata, but Exa's semantic scores are often
 * better; the score-max keeps whichever signal was strongest.
 *
 * Spec: docs/superpowers/specs/thoth-v2-design.md §2
 */
export async function dispatchSearch(args: {
  query: SearchQuery;
  providers: SearchProviderName[];
}): Promise<DispatchResult> {
  if (args.providers.length === 0) {
    return { hits: [], errors: [] };
  }

  const settled = await Promise.allSettled(
    args.providers.map(async (name) => {
      const fn = REGISTRY[name];
      if (!fn) {
        throw new SearchProviderError(name, `unknown provider: ${name}`);
      }
      return { name, hits: await fn(args.query) };
    }),
  );

  const errors: DispatchResult["errors"] = [];
  const byId = new Map<string, DiscoveredPaperSpec>();
  for (const result of settled) {
    if (result.status === "rejected") {
      const reason = result.reason;
      const provider =
        reason instanceof SearchProviderError
          ? reason.provider
          : ("unknown" as SearchProviderName);
      const message = reason instanceof Error ? reason.message : String(reason);
      errors.push({ provider, message });
      continue;
    }
    for (const hit of result.value.hits) {
      const existing = byId.get(hit.externalId);
      if (!existing || hit.initialScore > existing.initialScore) {
        byId.set(hit.externalId, hit);
      }
    }
  }

  const hits = Array.from(byId.values()).sort(
    (a, b) => b.initialScore - a.initialScore,
  );
  return { hits, errors };
}

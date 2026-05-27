import type { SearchProvider } from "@/lib/search/types";
import { SearchProviderError } from "@/lib/search/types";

/**
 * Exa adapter — semantic search via embeddings (vs. OpenAlex's lexical match).
 *
 * Free: 1000 searches/month. Requires `EXA_API_KEY` env var.
 * Used for tightening recall on niche / phrasing-sensitive queries where the
 * lexical providers miss.
 *
 * Docs: https://docs.exa.ai
 *
 * V2-M0 scaffolds the signature + tests. V2-M2 lands the real HTTP impl
 * (deferred a milestone because Exa is the third provider, not core).
 */
export const exaSearch: SearchProvider = async (_q) => {
  throw new SearchProviderError(
    "exa",
    "not implemented yet — landing in V2-M2",
  );
};

import type { SearchProvider } from "@/lib/search/types";
import { SearchProviderError } from "@/lib/search/types";

/**
 * arXiv adapter — preprints with always-OA PDFs.
 *
 * Free. Polite rate limit: 1 request per 3 seconds (per their guidance).
 * No auth. XML API; we parse with a small subset of fields.
 *
 * Docs: https://info.arxiv.org/help/api/index.html
 *
 * V2-M0 scaffolds the signature + tests. V2-M1 lands the real HTTP impl.
 */
export const arxivSearch: SearchProvider = async (_q) => {
  throw new SearchProviderError(
    "arxiv",
    "not implemented yet — landing in V2-M1",
  );
};

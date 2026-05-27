import type { SearchProvider } from "@/lib/search/types";
import { SearchProviderError } from "@/lib/search/types";

/**
 * OpenAlex adapter — primary metadata + open-access URL resolution.
 *
 * Free: 100k requests/day per IP, no auth needed. Polite tier ramps higher
 * if you add `?mailto=<your-email>` (we don't, for privacy — the demo flow
 * doesn't sign visitors up to OpenAlex's mailing list).
 *
 * Docs: https://docs.openalex.org/api-entities/works
 *
 * V2-M0 scaffolds the signature + tests. V2-M1 lands the real HTTP impl.
 */
export const openalexSearch: SearchProvider = async (_q) => {
  throw new SearchProviderError(
    "openalex",
    "not implemented yet — landing in V2-M1",
  );
};

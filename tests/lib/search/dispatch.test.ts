import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the three providers BEFORE importing the dispatcher.
vi.mock("@/lib/search/providers/openalex", () => ({
  openalexSearch: vi.fn(),
}));
vi.mock("@/lib/search/providers/arxiv", () => ({
  arxivSearch: vi.fn(),
}));
vi.mock("@/lib/search/providers/exa", () => ({
  exaSearch: vi.fn(),
}));

import { openalexSearch } from "@/lib/search/providers/openalex";
import { arxivSearch } from "@/lib/search/providers/arxiv";
import { exaSearch } from "@/lib/search/providers/exa";
import { dispatchSearch } from "@/lib/search/dispatch";
import { SearchProviderError, type DiscoveredPaperSpec } from "@/lib/search/types";

const hit = (
  provider: DiscoveredPaperSpec["provider"],
  externalId: string,
  initialScore: number,
): DiscoveredPaperSpec => ({
  provider,
  externalId,
  title: `Paper ${externalId}`,
  authors: ["A"],
  abstract: null,
  publicationYear: 2024,
  venue: null,
  citationCount: null,
  oaUrl: null,
  accessStatus: "unknown",
  initialScore,
});

beforeEach(() => {
  vi.mocked(openalexSearch).mockReset();
  vi.mocked(arxivSearch).mockReset();
  vi.mocked(exaSearch).mockReset();
});

describe("dispatchSearch", () => {
  it("returns empty hits + empty errors when no providers configured", async () => {
    const r = await dispatchSearch({ query: { query: "x" }, providers: [] });
    expect(r.hits).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(openalexSearch).not.toHaveBeenCalled();
  });

  it("fans out to every configured provider in parallel", async () => {
    vi.mocked(openalexSearch).mockResolvedValue([hit("openalex", "10.1/a", 0.9)]);
    vi.mocked(arxivSearch).mockResolvedValue([hit("arxiv", "2310.06770", 0.7)]);

    const r = await dispatchSearch({
      query: { query: "graph attention" },
      providers: ["openalex", "arxiv"],
    });

    expect(openalexSearch).toHaveBeenCalledTimes(1);
    expect(arxivSearch).toHaveBeenCalledTimes(1);
    expect(r.hits).toHaveLength(2);
    expect(r.errors).toEqual([]);
  });

  it("deduplicates by externalId, keeping the highest initialScore", async () => {
    // Same DOI surfaced by two providers; keep the higher-scored one.
    vi.mocked(openalexSearch).mockResolvedValue([hit("openalex", "10.1/dup", 0.4)]);
    vi.mocked(arxivSearch).mockResolvedValue([hit("arxiv", "10.1/dup", 0.85)]);

    const r = await dispatchSearch({
      query: { query: "x" },
      providers: ["openalex", "arxiv"],
    });

    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.provider).toBe("arxiv");
    expect(r.hits[0]!.initialScore).toBe(0.85);
  });

  it("sorts hits by initialScore descending", async () => {
    vi.mocked(openalexSearch).mockResolvedValue([
      hit("openalex", "10.1/a", 0.3),
      hit("openalex", "10.1/b", 0.9),
      hit("openalex", "10.1/c", 0.6),
    ]);

    const r = await dispatchSearch({
      query: { query: "x" },
      providers: ["openalex"],
    });

    expect(r.hits.map((h) => h.externalId)).toEqual(["10.1/b", "10.1/c", "10.1/a"]);
  });

  it("records per-provider errors without failing the dispatch", async () => {
    vi.mocked(openalexSearch).mockRejectedValue(
      new SearchProviderError("openalex", "503 Service Unavailable"),
    );
    vi.mocked(arxivSearch).mockResolvedValue([hit("arxiv", "x", 0.5)]);

    const r = await dispatchSearch({
      query: { query: "x" },
      providers: ["openalex", "arxiv"],
    });

    expect(r.hits).toHaveLength(1);
    expect(r.errors).toEqual([
      { provider: "openalex", message: "[openalex] 503 Service Unavailable" },
    ]);
  });

  it("classifies non-SearchProviderError rejections under provider=unknown", async () => {
    vi.mocked(openalexSearch).mockRejectedValue(new Error("boom"));

    const r = await dispatchSearch({
      query: { query: "x" },
      providers: ["openalex"],
    });

    expect(r.hits).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.provider).toBe("unknown");
    expect(r.errors[0]!.message).toBe("boom");
  });

  // Worst-case for outbound search: every provider rejects. Discoverer should
  // see empty hits + per-provider error entries and continue (the run will
  // then have an empty discoveredPapers list and the screener / fetcher gate
  // on it returning empty). Dispatcher MUST NOT throw — that would be an
  // uncaught rejection in the discoverer node and crash the run.
  it("returns empty hits + every provider's error when ALL providers fail", async () => {
    vi.mocked(openalexSearch).mockRejectedValue(
      new SearchProviderError("openalex", "network timeout"),
    );
    vi.mocked(arxivSearch).mockRejectedValue(
      new SearchProviderError("arxiv", "503 Service Unavailable"),
    );
    vi.mocked(exaSearch).mockRejectedValue(
      new SearchProviderError("exa", "missing API key"),
    );

    const r = await dispatchSearch({
      query: { query: "x" },
      providers: ["openalex", "arxiv", "exa"],
    });

    expect(r.hits).toEqual([]);
    expect(r.errors).toHaveLength(3);
    expect(r.errors.map((e) => e.provider).sort()).toEqual(["arxiv", "exa", "openalex"]);
  });
});

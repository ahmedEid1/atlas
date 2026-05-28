import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

import { exaSearch } from "@/lib/search/providers/exa";
import { SearchProviderError } from "@/lib/search/types";

const SAMPLE = {
  results: [
    {
      id: "exa_1",
      url: "https://arxiv.org/pdf/2310.06770.pdf",
      title: "ReAct: Synergizing Reasoning and Acting",
      score: 0.87,
      publishedDate: "2023-10-15T00:00:00.000Z",
      author: "Shunyu Yao, Jeffrey Zhao",
      text: "We propose a method to synergize reasoning and acting.",
    },
    {
      id: "exa_2",
      url: "https://example.com/papers/abc",  // landing page, not a PDF
      title: "Some publisher page",
      score: 0.62,
      publishedDate: "2024-03-01",
      author: null,
      text: null,
    },
  ],
};

function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("exaSearch", () => {
  it("throws SearchProviderError when EXA_API_KEY is missing", async () => {
    delete process.env.EXA_API_KEY;
    await expect(exaSearch({ query: "x" })).rejects.toBeInstanceOf(SearchProviderError);
    await expect(exaSearch({ query: "x" })).rejects.toMatchObject({
      provider: "exa",
      message: expect.stringContaining("missing API key"),
    });
  });

  it("maps Exa results to DiscoveredPaperSpec with PDF detection", async () => {
    process.env.EXA_API_KEY = "test-key";
    stubFetch(SAMPLE);

    const hits = await exaSearch({ query: "graph attention" });
    expect(hits).toHaveLength(2);

    const [pdf, page] = hits;
    expect(pdf!.provider).toBe("exa");
    expect(pdf!.externalId).toBe("https://arxiv.org/pdf/2310.06770.pdf");
    expect(pdf!.accessStatus).toBe("open");
    expect(pdf!.oaUrl).toBe("https://arxiv.org/pdf/2310.06770.pdf");
    expect(pdf!.publicationYear).toBe(2023);
    expect(pdf!.authors).toEqual(["Shunyu Yao", "Jeffrey Zhao"]);
    expect(pdf!.abstract).toContain("synergize");
    expect(pdf!.initialScore).toBeCloseTo(0.87);

    expect(page!.accessStatus).toBe("unknown");
    expect(page!.oaUrl).toBeNull();
    expect(page!.authors).toEqual([]);
    expect(page!.abstract).toBeNull();
  });

  it("clamps score into [0, 1] when Exa returns out-of-range", async () => {
    process.env.EXA_API_KEY = "test-key";
    stubFetch({
      results: [
        { id: "x", url: "https://x.org/a.pdf", title: "X", score: 1.5 },
        { id: "y", url: "https://x.org/b.pdf", title: "Y", score: -0.2 },
      ],
    });
    const hits = await exaSearch({ query: "x" });
    expect(hits[0]!.initialScore).toBe(1);
    expect(hits[1]!.initialScore).toBe(0);
  });

  it("yields null publicationYear (not NaN) for a non-ISO crawled date", async () => {
    process.env.EXA_API_KEY = "test-key";
    stubFetch({
      results: [
        { id: "x", url: "https://x.org/a.pdf", title: "X", score: 0.9, publishedDate: "Spring 2023" },
        { id: "y", url: "https://x.org/b.pdf", title: "Y", score: 0.8, publishedDate: null },
      ],
    });
    const hits = await exaSearch({ query: "x" });
    // A NaN year would crash the discoverer's createMany (Prisma rejects NaN
    // for the Int? column), failing the whole run.
    expect(hits[0]!.publicationYear).toBeNull();
    expect(hits[1]!.publicationYear).toBeNull();
  });

  it("forwards yearStart/yearEnd as startPublishedDate / endPublishedDate", async () => {
    process.env.EXA_API_KEY = "test-key";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await exaSearch({ query: "x", yearStart: 2020, yearEnd: 2024 });
    const body = JSON.parse(String((fetchMock.mock.calls as unknown[][])[0]![1]?.["body" as never]));
    expect(body.startPublishedDate).toBe("2020-01-01");
    expect(body.endPublishedDate).toBe("2024-12-31");
    expect(body.type).toBe("neural");
  });

  it("sends the API key in x-api-key (NOT Authorization)", async () => {
    process.env.EXA_API_KEY = "secret-123";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await exaSearch({ query: "x" });
    const callArgs = (fetchMock.mock.calls as unknown[][])[0]!;
    const init = callArgs[1] as { headers?: Record<string, string> } | undefined;
    const headers = init?.headers ?? {};
    expect(headers["x-api-key"]).toBe("secret-123");
    expect(headers["Authorization" as keyof typeof headers]).toBeUndefined();
  });

  it("throws SearchProviderError on HTTP error", async () => {
    process.env.EXA_API_KEY = "test-key";
    stubFetch("Forbidden", 403);
    await expect(exaSearch({ query: "x" })).rejects.toBeInstanceOf(SearchProviderError);
    await expect(exaSearch({ query: "x" })).rejects.toMatchObject({
      provider: "exa",
      message: expect.stringContaining("403"),
    });
  });

  it("throws SearchProviderError on network failure", async () => {
    process.env.EXA_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(exaSearch({ query: "x" })).rejects.toBeInstanceOf(SearchProviderError);
    await expect(exaSearch({ query: "x" })).rejects.toMatchObject({
      provider: "exa",
      message: expect.stringContaining("network error"),
    });
  });

  it("skips results missing title or url", async () => {
    process.env.EXA_API_KEY = "test-key";
    stubFetch({
      results: [
        { id: "x", url: "https://x.org/a.pdf", title: null, score: 0.5 },
        { id: "y", title: "No URL", score: 0.5 },
        { id: "z", url: "https://x.org/c.pdf", title: "Valid", score: 0.5 },
      ],
    });
    const hits = await exaSearch({ query: "x" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe("Valid");
  });
});

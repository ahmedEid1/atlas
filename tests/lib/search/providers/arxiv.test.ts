import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

import { arxivSearch, parseArxivAtom } from "@/lib/search/providers/arxiv";
import { SearchProviderError } from "@/lib/search/types";

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2310.06770v2</id>
    <updated>2023-10-15T00:00:00Z</updated>
    <published>2023-10-10T00:00:00Z</published>
    <title>ReAct: Synergizing Reasoning and Acting in Language Models</title>
    <summary>We explore the use of LLMs to generate reasoning traces and actions.</summary>
    <author><name>Shunyu Yao</name></author>
    <author><name>Jeffrey Zhao</name></author>
    <link href="http://arxiv.org/abs/2310.06770v2" rel="alternate" type="text/html"/>
    <link href="http://arxiv.org/pdf/2310.06770v2" rel="related" type="application/pdf"/>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.48550/arxiv.2310.06770</arxiv:doi>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2205.11916v1</id>
    <published>2022-05-24T00:00:00Z</published>
    <title>Large Language Models are Zero-Shot Reasoners</title>
    <summary>Chain-of-thought prompting boosts performance.</summary>
    <author><name>Takeshi Kojima</name></author>
  </entry>
</feed>`;

describe("parseArxivAtom", () => {
  it("extracts both entries with all required fields", () => {
    const hits = parseArxivAtom(SAMPLE_FEED);
    expect(hits).toHaveLength(2);

    const [first, second] = hits;
    // First entry — has DOI, prefer that as externalId for cross-provider dedup
    expect(first!.provider).toBe("arxiv");
    expect(first!.externalId).toBe("10.48550/arxiv.2310.06770");
    expect(first!.title).toBe("ReAct: Synergizing Reasoning and Acting in Language Models");
    expect(first!.authors).toEqual(["Shunyu Yao", "Jeffrey Zhao"]);
    expect(first!.abstract).toContain("reasoning traces");
    expect(first!.publicationYear).toBe(2023);
    expect(first!.venue).toBe("arXiv");
    expect(first!.oaUrl).toBe("https://arxiv.org/pdf/2310.06770v2");
    expect(first!.accessStatus).toBe("open");
    expect(first!.initialScore).toBe(1); // first hit scores 1.0

    // Second entry — no DOI, fall back to arxiv:<id>
    expect(second!.externalId).toBe("arxiv:2205.11916");
    expect(second!.publicationYear).toBe(2022);
    expect(second!.initialScore).toBeCloseTo(0.5); // 1/(1+1)
  });

  it("normalizes the version suffix from arxiv ids so v1/v2 dedupe", () => {
    const feed = `<feed>
      <entry>
        <id>http://arxiv.org/abs/2310.06770v3</id>
        <title>X</title>
        <published>2023-01-01T00:00:00Z</published>
      </entry>
    </feed>`;
    const hits = parseArxivAtom(feed);
    expect(hits[0]!.externalId).toBe("arxiv:2310.06770");
  });

  it("falls back to canonical pdf URL when the <link type=pdf> tag is missing", () => {
    const feed = `<feed><entry>
      <id>http://arxiv.org/abs/1234.5678v1</id>
      <title>Y</title>
      <published>2024-01-01T00:00:00Z</published>
    </entry></feed>`;
    const hits = parseArxivAtom(feed);
    expect(hits[0]!.oaUrl).toBe("https://arxiv.org/pdf/1234.5678");
  });

  it("applies yearStart/yearEnd filters client-side", () => {
    const hits = parseArxivAtom(SAMPLE_FEED, { yearStart: 2023 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.publicationYear).toBe(2023);

    const hits2 = parseArxivAtom(SAMPLE_FEED, { yearEnd: 2022 });
    expect(hits2).toHaveLength(1);
    expect(hits2[0]!.publicationYear).toBe(2022);
  });

  it("keeps a paper with no <published> date even when a year filter is set", () => {
    // A paper missing publication metadata must NOT be silently dropped by the
    // year filter — the code guards `publicationYear !== null` before comparing,
    // because `null < yearStart` would coerce (null→0) into a spurious drop.
    // (Now load-bearing since M115 made the per-project year filter live.)
    const feed = `<feed>
      <entry>
        <id>http://arxiv.org/abs/2401.00001v1</id>
        <title>Undated preprint</title>
        <summary>No published date in this entry.</summary>
      </entry>
    </feed>`;
    const hits = parseArxivAtom(feed, { yearStart: 2023, yearEnd: 2024 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.publicationYear).toBeNull();
  });

  it("yields null publicationYear (not NaN) for a malformed <published> date", () => {
    // Defensive: a non-numeric <published> prefix would make parseInt return
    // NaN, which would crash the discoverer's createMany (Prisma rejects NaN
    // for the Int? column).
    const feed = `<feed>
      <entry>
        <id>http://arxiv.org/abs/2401.00002v1</id>
        <title>Weird date paper</title>
        <published>n/a</published>
      </entry>
    </feed>`;
    const hits = parseArxivAtom(feed);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.publicationYear).toBeNull();
  });

  it("returns empty array for a feed with no entries", () => {
    expect(parseArxivAtom(`<feed></feed>`)).toEqual([]);
  });

  it("skips entries missing title or id", () => {
    const feed = `<feed>
      <entry><title>No id</title></entry>
      <entry><id>http://arxiv.org/abs/9999.1234v1</id></entry>
      <entry>
        <id>http://arxiv.org/abs/9999.5678v1</id>
        <title>Valid</title>
        <published>2024-01-01T00:00:00Z</published>
      </entry>
    </feed>`;
    const hits = parseArxivAtom(feed);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe("Valid");
  });

  it("collapses internal whitespace in title + abstract", () => {
    const feed = `<feed><entry>
      <id>http://arxiv.org/abs/1234.5678v1</id>
      <title>A
         multi-line
         title</title>
      <summary>One   two   three.</summary>
      <published>2024-01-01T00:00:00Z</published>
    </entry></feed>`;
    const hits = parseArxivAtom(feed);
    expect(hits[0]!.title).toBe("A multi-line title");
    expect(hits[0]!.abstract).toBe("One two three.");
  });
});

describe("arxivSearch (HTTP integration)", () => {
  it("hits the arXiv API and returns parsed entries", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(SAMPLE_FEED, {
        status: 200,
        headers: { "content-type": "application/atom+xml" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const hits = await arxivSearch({ query: "react reasoning" });
    expect(hits).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String((fetchMock.mock.calls as unknown[][])[0]![0]);
    expect(url).toContain("api/query");
    expect(url).toContain("search_query=all%3Areact+reasoning");
  });

  it("throws SearchProviderError on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Internal Server Error", { status: 500 })),
    );
    await expect(arxivSearch({ query: "x" })).rejects.toBeInstanceOf(SearchProviderError);
    await expect(arxivSearch({ query: "x" })).rejects.toMatchObject({
      provider: "arxiv",
      message: expect.stringContaining("500"),
    });
  });

  it("throws SearchProviderError on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("ECONNRESET"); }));
    await expect(arxivSearch({ query: "x" })).rejects.toBeInstanceOf(SearchProviderError);
    await expect(arxivSearch({ query: "x" })).rejects.toMatchObject({
      provider: "arxiv",
      message: expect.stringContaining("network error"),
    });
  });
});

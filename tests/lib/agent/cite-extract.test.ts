import { describe, it, expect } from "vitest";
import { extractCitations } from "@/lib/agent/cite-extract";

describe("extractCitations", () => {
  it("returns an empty array for text with no citations", () => {
    expect(extractCitations("This draft has no citations at all.")).toEqual([]);
  });

  it("extracts a single citation with surrounding sentence", () => {
    const draft = "Foo is well-known. CBT reduces back pain at 6 months [c1]. Other claims follow.";
    expect(extractCitations(draft)).toEqual([
      { paperId: "c1", claim: "CBT reduces back pain at 6 months [c1]." },
    ]);
  });

  it("extracts multiple distinct (paperId, sentence) pairs from across the draft", () => {
    const draft = "Two findings agree [c1] [c2]. A separate sentence cites [c1] too.";
    const result = extractCitations(draft);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.paperId).sort()).toEqual(["c1", "c1", "c2"]);
  });

  it("deduplicates identical (paperId, sentence) pairs within one sentence", () => {
    // The drafter LLM sometimes restates the same citation later in the same
    // sentence ("Smith found X [c1] and Jones reported Y [c1]"). Both mentions
    // produce the same cite_check prompt; we coalesce them to avoid burning a
    // paid LLM call on an identical verdict.
    const draft = "Smith found X [c1] and Jones reported Y [c1].";
    const result = extractCitations(draft);
    expect(result).toHaveLength(1);
    expect(result[0]?.paperId).toBe("c1");
  });

  it("treats markdown formatting around citations correctly (lists, headings)", () => {
    const draft = "## Findings\n\n- Item one [paper_abc].\n- Item two [paper_def].\n";
    const result = extractCitations(draft);
    expect(result).toHaveLength(2);
    expect(result[0]?.paperId).toBe("paper_abc");
    expect(result[1]?.paperId).toBe("paper_def");
  });

  it("ignores bracketed text that isn't a paper id (e.g., [todo], [link text](url))", () => {
    const draft = "This has [text in brackets] and [a link](https://x.com) but no real citation.";
    expect(extractCitations(draft)).toEqual([]);
  });

  it("strips leading/trailing whitespace from the claim", () => {
    const draft = "\n\n   Lonely fact [c1].   \n";
    const result = extractCitations(draft);
    expect(result[0]?.claim).toBe("Lonely fact [c1].");
  });
});

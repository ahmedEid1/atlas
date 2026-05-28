import { describe, it, expect } from "vitest";
import { corpusItemLabel } from "@/components/corpus/corpus-item-list";

describe("corpusItemLabel", () => {
  describe("from parsedMarkdown", () => {
    it("extracts the first H1 heading as the title", () => {
      const md = "# A Systematic Review of Archaeal Hibernation\n\nAbstract here.";
      expect(corpusItemLabel({ source: "corpus/proj/blob.pdf", parsedMarkdown: md })).toBe(
        "A Systematic Review of Archaeal Hibernation",
      );
    });

    it("extracts the first H2 heading if there's no H1 (some Mistral OCRs do this)", () => {
      const md = "## Probabilistic Inference at Scale\n\nIntro.";
      expect(corpusItemLabel({ source: "openalex:W42", parsedMarkdown: md })).toBe(
        "Probabilistic Inference at Scale",
      );
    });

    it("skips blank lines before the heading", () => {
      const md = "\n\n   \n# After Blanks\n\nbody";
      expect(corpusItemLabel({ source: "x", parsedMarkdown: md })).toBe("After Blanks");
    });

    it("truncates titles longer than 140 chars with an ellipsis", () => {
      const long = "A".repeat(200);
      const md = `# ${long}\n\nrest`;
      const out = corpusItemLabel({ source: "x", parsedMarkdown: md });
      expect(out.length).toBe(138);
      expect(out.endsWith("…")).toBe(true);
    });

    it("falls through to source when the heading is empty after trimming", () => {
      const md = "#   \n\nbody";
      expect(corpusItemLabel({ source: "arxiv:2310.06770", parsedMarkdown: md })).toBe(
        "arXiv 2310.06770",
      );
    });
  });

  describe("source fallback", () => {
    it("strips the R2 project prefix from upload keys", () => {
      expect(
        corpusItemLabel({
          source: "corpus/proj_xyz/abc-123.pdf",
          parsedMarkdown: null,
        }),
      ).toBe("abc-123.pdf");
    });

    it("humanises openalex / arxiv / exa prefixes", () => {
      expect(corpusItemLabel({ source: "openalex:W4234567", parsedMarkdown: null })).toBe(
        "OpenAlex W4234567",
      );
      expect(corpusItemLabel({ source: "arxiv:2310.06770", parsedMarkdown: null })).toBe(
        "arXiv 2310.06770",
      );
      expect(corpusItemLabel({ source: "exa:https://example.com/p", parsedMarkdown: null })).toBe(
        "Exa https://example.com/p",
      );
    });

    it("passes unknown shapes through unchanged — forward-compat for new providers", () => {
      expect(corpusItemLabel({ source: "semantic_scholar:abc", parsedMarkdown: null })).toBe(
        "semantic_scholar:abc",
      );
    });
  });
});

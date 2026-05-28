import { describe, it, expect } from "vitest";
import { corpusItemLabel, sanitiseTitle } from "@/components/corpus/corpus-item-list";

describe("sanitiseTitle", () => {
  it("strips markdown emphasis markers but keeps wrapped text", () => {
    expect(sanitiseTitle("**Bold Title** Here")).toBe("Bold Title Here");
    expect(sanitiseTitle("*Italic Title*")).toBe("Italic Title");
    expect(sanitiseTitle("__Underline Title__")).toBe("Underline Title");
    expect(sanitiseTitle("_emphasised_ word")).toBe("emphasised word");
  });

  it("strips inline LaTeX wrappers, keeping the argument", () => {
    expect(sanitiseTitle("$\\mathrm{Foo}$ in physics")).toBe("Foo in physics");
    expect(sanitiseTitle("${Bar}$")).toBe("Bar");
    expect(sanitiseTitle("$baz$ qux")).toBe("baz qux");
  });

  it("strips surrounding quotes (straight + curly)", () => {
    expect(sanitiseTitle('"A Quoted Title"')).toBe("A Quoted Title");
    expect(sanitiseTitle("“Curly Quoted”")).toBe("Curly Quoted");
    expect(sanitiseTitle("'Singled'")).toBe("Singled");
  });

  it("collapses internal whitespace runs", () => {
    expect(sanitiseTitle("foo    bar\t\tbaz")).toBe("foo bar baz");
  });

  it("passes a clean title through unchanged", () => {
    expect(sanitiseTitle("Archaeal Hibernation: A Systematic Review")).toBe(
      "Archaeal Hibernation: A Systematic Review",
    );
  });

  it("handles compound LaTeX + emphasis without infinite-looping", () => {
    expect(sanitiseTitle("**$\\textbf{Strong}$** ideas")).toBe("Strong ideas");
  });
});

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

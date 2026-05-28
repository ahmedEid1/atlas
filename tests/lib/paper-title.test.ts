import { describe, it, expect } from "vitest";
import {
  extractPaperTitle,
  sanitiseTitle,
  formatAuthors,
  formatReferenceLine,
} from "@/lib/paper-title";

describe("extractPaperTitle", () => {
  it("returns the first H1 heading, sanitised", () => {
    expect(extractPaperTitle("# **Bold Title**\n\nbody")).toBe("Bold Title");
  });

  it("returns the first H2 heading when there's no H1", () => {
    expect(extractPaperTitle("## Subsection Title\n\nbody")).toBe("Subsection Title");
  });

  it("skips blank lines before the heading", () => {
    expect(extractPaperTitle("\n\n   \n# After Blanks")).toBe("After Blanks");
  });

  it("unwraps LaTeX + emphasis (shared sanitiser)", () => {
    expect(extractPaperTitle("# $\\mathrm{GAT}$ networks")).toBe("GAT networks");
  });

  it("returns null for empty / null / undefined markdown", () => {
    expect(extractPaperTitle(null)).toBeNull();
    expect(extractPaperTitle(undefined)).toBeNull();
    expect(extractPaperTitle("")).toBeNull();
  });

  it("returns null when no H1/H2 heading exists", () => {
    expect(extractPaperTitle("### Only an H3\n\nbody")).toBeNull();
    expect(extractPaperTitle("just prose, no headings")).toBeNull();
  });

  it("returns null when the heading is empty after sanitising", () => {
    expect(extractPaperTitle("#   \n\nbody")).toBeNull();
  });
});

describe("sanitiseTitle (shared with corpus list)", () => {
  it("is the same implementation the corpus list imports", () => {
    // Smoke check — the corpus-item-label.test.ts covers the full matrix;
    // this asserts the export is reachable from the new lib path.
    expect(sanitiseTitle("**x**")).toBe("x");
  });
});

describe("formatAuthors", () => {
  it("returns null for empty / null / undefined", () => {
    expect(formatAuthors([])).toBeNull();
    expect(formatAuthors(null)).toBeNull();
    expect(formatAuthors(undefined)).toBeNull();
  });

  it("joins up to 3 authors with commas", () => {
    expect(formatAuthors(["A"])).toBe("A");
    expect(formatAuthors(["A", "B"])).toBe("A, B");
    expect(formatAuthors(["A", "B", "C"])).toBe("A, B, C");
  });

  it("caps at 3 + 'et al.' for 4 or more", () => {
    expect(formatAuthors(["A", "B", "C", "D"])).toBe("A, B, C, et al.");
    expect(formatAuthors(["A", "B", "C", "D", "E"])).toBe("A, B, C, et al.");
  });
});

describe("formatReferenceLine", () => {
  it("renders the full shape when every field is present", () => {
    expect(
      formatReferenceLine({
        paperId: "cm_a",
        title: "Graph Attention Networks",
        authors: ["P. Veličković", "G. Cucurull"],
        year: 2018,
        venue: "ICLR",
        externalDoi: "10.1/gat",
        externalArxivId: null,
      }),
    ).toBe(
      "- **[cm_a]** Graph Attention Networks — P. Veličković, G. Cucurull (2018) · ICLR · https://doi.org/10.1/gat",
    );
  });

  it("falls back to 'Untitled paper' for a null title", () => {
    expect(
      formatReferenceLine({
        paperId: "cm_b",
        title: null,
        externalDoi: null,
        externalArxivId: null,
      }),
    ).toBe("- **[cm_b]** Untitled paper");
  });

  it("uses the arXiv link when there's no DOI", () => {
    expect(
      formatReferenceLine({
        paperId: "cm_c",
        title: "Chain of Thought",
        year: 2022,
        externalDoi: null,
        externalArxivId: "2201.11903",
      }),
    ).toBe("- **[cm_c]** Chain of Thought — (2022) · https://arxiv.org/abs/2201.11903");
  });

  it("omits author/year/venue/link sections that are absent (uploaded PDF)", () => {
    expect(
      formatReferenceLine({
        paperId: "cm_d",
        title: "Uploaded Paper",
        externalDoi: null,
        externalArxivId: null,
      }),
    ).toBe("- **[cm_d]** Uploaded Paper");
  });
});

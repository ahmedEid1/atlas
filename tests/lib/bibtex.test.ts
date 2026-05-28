import { describe, it, expect } from "vitest";
import { paperToBibtex, buildBibtexFile } from "@/lib/bibtex";

describe("paperToBibtex", () => {
  it("emits @article when a DOI is present", () => {
    const out = paperToBibtex({
      citationKey: "paper_001",
      title: "Test paper",
      externalDoi: "10.1038/s41586-021-03819-2",
      externalArxivId: null,
      source: null,
    });
    expect(out).toContain("@article{paper_001,");
    expect(out).toContain("title = {Test paper}");
    expect(out).toContain("doi = {10.1038/s41586-021-03819-2}");
    expect(out).toContain("url = {https://doi.org/10.1038/s41586-021-03819-2}");
  });

  it("emits @misc + archivePrefix for arXiv-only preprints", () => {
    const out = paperToBibtex({
      citationKey: "paper_002",
      title: "Chain of thought prompting",
      externalDoi: null,
      externalArxivId: "2201.11903",
      source: null,
    });
    expect(out).toContain("@misc{paper_002,");
    expect(out).toContain("eprint = {2201.11903}");
    expect(out).toContain("archivePrefix = {arXiv}");
    expect(out).toContain("url = {https://arxiv.org/abs/2201.11903}");
  });

  it("includes both DOI + arXiv fields when both are present, prefers DOI url", () => {
    const out = paperToBibtex({
      citationKey: "paper_003",
      title: "Cross-referenced paper",
      externalDoi: "10.1/foo",
      externalArxivId: "2401.12345",
      source: null,
    });
    expect(out).toContain("@article{paper_003,");
    expect(out).toContain("doi = {10.1/foo}");
    expect(out).toContain("eprint = {2401.12345}");
    // DOI URL wins when both present — arXiv URL is omitted.
    expect(out).toContain("url = {https://doi.org/10.1/foo}");
    expect(out).not.toContain("url = {https://arxiv.org/abs/2401.12345}");
  });

  it("falls back to @misc + source note for uploaded PDFs with no external id", () => {
    const out = paperToBibtex({
      citationKey: "paper_004",
      title: "User's uploaded paper",
      externalDoi: null,
      externalArxivId: null,
      source: "corpus/abc/xyz.pdf",
    });
    expect(out).toContain("@misc{paper_004,");
    expect(out).toContain("note = {Uploaded PDF: corpus/abc/xyz.pdf}");
  });

  it("uses 'Untitled paper' when title is null (BibTeX requires non-empty)", () => {
    const out = paperToBibtex({
      citationKey: "paper_005",
      title: null,
      externalDoi: "10.1/x",
      externalArxivId: null,
      source: null,
    });
    expect(out).toContain("title = {Untitled paper}");
  });

  it("escapes BibTeX special characters in title (backslash, braces, @)", () => {
    const out = paperToBibtex({
      citationKey: "paper_006",
      title: "A {brace} and a \\backslash and an @symbol",
      externalDoi: null,
      externalArxivId: null,
      source: null,
    });
    expect(out).toContain("title = {A \\{brace\\} and a \\\\backslash and an \\@symbol}");
  });

  it("escapes %, $, &, # in title — without escaping, % would comment out the closing brace", () => {
    const out = paperToBibtex({
      citationKey: "paper_007",
      // Title has every additional special added by M95.
      title: "Cost 50% off & $5 discount #urgent",
      externalDoi: null,
      externalArxivId: null,
      source: null,
    });
    expect(out).toContain(
      "title = {Cost 50\\% off \\& \\$5 discount \\#urgent}",
    );
  });

  it("emits author / year / journal when present (M97 — V2 discovered papers)", () => {
    const out = paperToBibtex({
      citationKey: "paper_008",
      title: "Graph Attention Networks",
      externalDoi: "10.1/gat",
      externalArxivId: null,
      source: null,
      authors: ["Petar Veličković", "Guillem Cucurull", "Arantxa Casanova"],
      year: 2018,
      venue: "ICLR",
    });
    // BibTeX joins authors with " and ".
    expect(out).toContain(
      "author = {Petar Veličković and Guillem Cucurull and Arantxa Casanova}",
    );
    expect(out).toContain("year = {2018}");
    expect(out).toContain("journal = {ICLR}");
  });

  it("omits author / year / journal when absent (uploaded PDFs)", () => {
    const out = paperToBibtex({
      citationKey: "paper_009",
      title: "Uploaded paper with no metadata",
      externalDoi: null,
      externalArxivId: null,
      source: "corpus/p/x.pdf",
      authors: null,
      year: null,
      venue: null,
    });
    expect(out).not.toContain("author =");
    expect(out).not.toContain("year =");
    expect(out).not.toContain("journal =");
  });

  it("omits author when the list is present but empty", () => {
    const out = paperToBibtex({
      citationKey: "paper_010",
      title: "x",
      externalDoi: null,
      externalArxivId: null,
      source: null,
      authors: [],
      year: 2020,
      venue: null,
    });
    expect(out).not.toContain("author =");
    expect(out).toContain("year = {2020}");
  });

  it("sanitises non-alphanumeric chars in citation key", () => {
    const out = paperToBibtex({
      citationKey: "10.1/some-doi/with/slashes",
      title: "x", externalDoi: null, externalArxivId: null, source: null,
    });
    // Slashes → underscores; alphanumeric + `-_:` preserved.
    expect(out).toContain("{10.1_some-doi_with_slashes,");
    expect(out).not.toContain("/");
  });
});

describe("buildBibtexFile", () => {
  it("emits a Thoth header + one entry per paper", () => {
    const file = buildBibtexFile([
      { citationKey: "paper_001", title: "A", externalDoi: "10.1/a", externalArxivId: null, source: null },
      { citationKey: "paper_002", title: "B", externalDoi: null, externalArxivId: "2201.11903", source: null },
    ]);
    expect(file).toMatch(/^% Generated by Thoth/);
    expect(file).toContain("@article{paper_001,");
    expect(file).toContain("@misc{paper_002,");
    // Entries separated by a blank line (readable .bib file).
    expect(file).toContain("}\n\n@");
  });

  it("emits a friendly comment when the included-set is empty", () => {
    const file = buildBibtexFile([]);
    expect(file).toBe("% No papers included in this review.\n");
  });
});

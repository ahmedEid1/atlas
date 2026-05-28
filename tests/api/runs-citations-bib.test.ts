import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { run: { findUnique: vi.fn() } },
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/runs/[id]/citations.bib", () => {
  it("returns a BibTeX file with one entry per IncludedPaper", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      id: "r1",
      draft: "# Review",
      createdAt: new Date("2026-05-28T14:00:00Z"),
      completedAt: new Date("2026-05-28T14:15:30Z"),
      question: "How does archaeal hibernation work?",
      project: { ownerId: "u1", title: "GAT Review" },
      includedPapers: [
        {
          id: "ip1",
          corpusItem: {
            source: "corpus/p1/a.pdf",
            externalDoi: "10.1/test",
            externalArxivId: null,
            parsedMarkdown: "# First paper title\n\nText.",
            // Uploaded PDF — no DiscoveredPaper, so no author/year/venue.
            discoveredAs: null,
          },
        },
        {
          id: "ip2",
          corpusItem: {
            source: "arxiv:arxiv:2201.11903",
            externalDoi: null,
            externalArxivId: "2201.11903",
            parsedMarkdown: "# Chain of thought prompting\n\nText.",
            // V2 discovered paper — M97 joins these into the BibTeX.
            discoveredAs: {
              authors: ["Jason Wei", "Xuezhi Wang"],
              publicationYear: 2022,
              venue: "NeurIPS",
            },
          },
        },
      ],
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/citations.bib/route");
    const res = await GET(
      new NextRequest("http://localhost/api/runs/r1/citations.bib"),
      { params: Promise.resolve({ id: "r1" }) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-bibtex");
    // M66: filename slugged from project title + run date.
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="thoth-gat-review-2026-05-28.citations.bib"',
    );

    const body = await res.text();
    // Citation keys follow the draft's paper_NNN convention (zero-padded).
    expect(body).toContain("@article{paper_001,");
    expect(body).toContain("@misc{paper_002,");
    // Titles pulled from the first '# ' heading in each parsedMarkdown.
    expect(body).toContain("title = {First paper title}");
    expect(body).toContain("title = {Chain of thought prompting}");
    expect(body).toContain("doi = {10.1/test}");
    expect(body).toContain("eprint = {2201.11903}");
    // M97: the V2 discovered paper (paper_002) gets author/year/journal
    // from its DiscoveredPaper join; the uploaded PDF (paper_001) does not.
    expect(body).toContain("author = {Jason Wei and Xuezhi Wang}");
    expect(body).toContain("year = {2022}");
    expect(body).toContain("journal = {NeurIPS}");
  });

  it("returns 404 for runs with no draft (citations only after the agent completes)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      id: "r1", draft: null,
      project: { ownerId: "u1" },
      includedPapers: [],
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/citations.bib/route");
    const res = await GET(
      new NextRequest("http://localhost/api/runs/r1/citations.bib"),
      { params: Promise.resolve({ id: "r1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for unowned runs (existence-probe defense)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      draft: "x", project: { ownerId: "u2" }, includedPapers: [],
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/citations.bib/route");
    const res = await GET(
      new NextRequest("http://localhost/api/runs/r1/citations.bib"),
      { params: Promise.resolve({ id: "r1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("unauth"));

    const { GET } = await import("@/app/api/runs/[id]/citations.bib/route");
    const res = await GET(
      new NextRequest("http://localhost/api/runs/r1/citations.bib"),
      { params: Promise.resolve({ id: "r1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("emits the friendly empty-corpus comment when no papers were included", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      id: "r1", draft: "Review with no citations.",
      createdAt: new Date("2026-05-28T14:00:00Z"),
      completedAt: null,
      question: "Empty citations test",
      project: { ownerId: "u1", title: "Empty Review" },
      includedPapers: [],
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/citations.bib/route");
    const res = await GET(
      new NextRequest("http://localhost/api/runs/r1/citations.bib"),
      { params: Promise.resolve({ id: "r1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // M76: provenance preamble is prepended even when the corpus is empty.
    expect(body).toContain("% Project: Empty Review");
    expect(body).toContain("% Question: Empty citations test");
    expect(body).toContain("% No papers included in this review.");
  });
});

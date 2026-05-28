import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { buildBibtexFile, type BibTexPaper } from "@/lib/bibtex";
import { buildRunFilename } from "@/lib/download-filename";
import { extractPaperTitle } from "@/lib/paper-title";

/**
 * Download a completed Run's included papers as a BibTeX file.
 *
 * Each IncludedPaper joins its CorpusItem to source title + DOI /
 * arXiv id / R2 blob key. The BibTeX builder picks `@article` when a
 * DOI is present, `@misc` otherwise — and the citation key matches
 * the draft's `[paper_XXX]` style so a researcher can search-and-
 * replace into a LaTeX manuscript.
 *
 * Filename: `thoth-<runId>-citations.bib`. `Cache-Control: no-store`
 * matches the M34 / M35 download endpoints. 404 for "no draft yet"
 * (no IncludedPaper rows until the papers_gate approves), unowned,
 * or missing.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const run = await db.run.findUnique({
    where: { id },
    select: {
      id: true,
      draft: true,
      createdAt: true,
      completedAt: true,
      question: true,
      project: { select: { ownerId: true, title: true } },
      includedPapers: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          corpusItem: {
            select: {
              source: true,
              externalDoi: true,
              externalArxivId: true,
              parsedMarkdown: true,
              // M97: V2 discovered papers carry author/year/venue on the
              // DiscoveredPaper row (one per corpus item via the
              // discoveredAs back-relation). Join it so the BibTeX gets
              // real bibliographic fields, not just title + DOI. Null for
              // uploaded PDFs (no DiscoveredPaper).
              discoveredAs: {
                select: { authors: true, publicationYear: true, venue: true },
              },
            },
          },
        },
      },
    },
  });
  if (!run || run.project.ownerId !== user.id || !run.draft) {
    return new NextResponse("Not found", { status: 404 });
  }

  const papers: BibTexPaper[] = run.includedPapers.map((ip, idx) => {
    // Shared title extraction (lib/paper-title.ts) — same sanitisation
    // the corpus-list UI uses, so a title like `# **Bold**` doesn't
    // leak literal asterisks into the BibTeX. Handles H1 AND H2 (the
    // old inline version only matched `# `, missing H2-only OCR output).
    const title = extractPaperTitle(ip.corpusItem.parsedMarkdown);
    // Citation key matches the `paper_NNN` pattern the assessor uses
    // when writing claims to the draft. assessor.ts numbers them in
    // include-list order, so we match that here.
    const citationKey = `paper_${String(idx + 1).padStart(3, "0")}`;
    const discovered = ip.corpusItem.discoveredAs;
    return {
      citationKey,
      title,
      externalDoi: ip.corpusItem.externalDoi,
      externalArxivId: ip.corpusItem.externalArxivId,
      source: ip.corpusItem.source,
      authors: discovered?.authors ?? null,
      year: discovered?.publicationYear ?? null,
      venue: discovered?.venue ?? null,
    };
  });

  // Prepend a `%` provenance preamble before the buildBibtexFile output.
  // BibTeX treats `%`-prefixed lines as comments, so the metadata is
  // visible at the top of the file but ignored by every parser. Sanitise
  // newlines so a title with a stray \n can't break out of the comment.
  const sanitiseLine = (s: string) => s.replace(/[\r\n]+/g, " ");
  const provenance = [
    `% Project: ${sanitiseLine(run.project.title)}`,
    `% Question: ${sanitiseLine(run.question)}`,
    `% Run started: ${run.createdAt.toISOString()}`,
    run.completedAt ? `% Run completed: ${run.completedAt.toISOString()}` : null,
    `% Generated: ${new Date().toISOString()}`,
    "%",
    "",
  ].filter(Boolean).join("\n");
  const body = provenance + buildBibtexFile(papers);
  const filename = buildRunFilename({
    projectTitle: run.project.title,
    runId: id,
    startedAt: run.createdAt,
    suffix: "citations.bib",
  });

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "application/x-bibtex; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

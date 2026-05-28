import { extractPaperTitle } from "@/lib/paper-title";
import type { DraftReference } from "@/components/runs/draft-view";

/**
 * The IncludedPaper shape (with its CorpusItem + DiscoveredPaper join)
 * needed to build a DraftReference. Three surfaces select exactly this
 * shape — the draft.md download route, the run-detail page, and the
 * public showcase page — so the Prisma `select` is centralised here as
 * `INCLUDED_PAPER_REFERENCE_SELECT` and the mapping as
 * `toDraftReferences`. Keeps the three callers from drifting (the M96
 * lesson: two copies of "extract a title" had silently diverged).
 */
export type IncludedPaperForReference = {
  corpusItemId: string;
  corpusItem: {
    parsedMarkdown: string | null;
    externalDoi: string | null;
    externalArxivId: string | null;
    discoveredAs: {
      authors: string[];
      publicationYear: number | null;
      venue: string | null;
    } | null;
  };
};

/**
 * Prisma `select` fragment for the included-paper → reference join.
 * Spread into a `run.findUnique`/`findFirst` include so all three
 * reference-rendering surfaces fetch the same columns.
 */
export const INCLUDED_PAPER_REFERENCE_SELECT = {
  corpusItemId: true,
  corpusItem: {
    select: {
      parsedMarkdown: true,
      externalDoi: true,
      externalArxivId: true,
      discoveredAs: {
        select: { authors: true, publicationYear: true, venue: true },
      },
    },
  },
} as const;

/**
 * Map included-paper rows to the DraftReference shape the draft
 * References surfaces (on-page + .md download) consume. Title via the
 * shared `extractPaperTitle`; author/year/venue from the
 * DiscoveredPaper join (null for uploaded PDFs).
 */
export function toDraftReferences(
  includedPapers: IncludedPaperForReference[],
): DraftReference[] {
  return includedPapers.map((ip) => ({
    paperId: ip.corpusItemId,
    title: extractPaperTitle(ip.corpusItem.parsedMarkdown),
    authors: ip.corpusItem.discoveredAs?.authors ?? null,
    year: ip.corpusItem.discoveredAs?.publicationYear ?? null,
    venue: ip.corpusItem.discoveredAs?.venue ?? null,
    externalDoi: ip.corpusItem.externalDoi,
    externalArxivId: ip.corpusItem.externalArxivId,
  }));
}

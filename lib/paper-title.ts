/**
 * Shared paper-title helpers used by:
 *   - the corpus list UI (display label)
 *   - the citations.bib download route (BibTeX `title` field)
 *
 * Both need to turn Mistral-OCR'd markdown into a clean human title,
 * so the logic lives here once rather than diverging (the .bib route
 * previously did its own bare `# `-heading extraction with no
 * sanitisation, leaking literal `**asterisks**` into BibTeX).
 */

/**
 * Strip common Mistral-OCR title artefacts: markdown emphasis
 * (`**bold**`, `*italic*`, `_emph_`, `` `code` ``), inline LaTeX
 * commands (`$\mathrm{Foo}$` → `Foo`), surrounding quotes, and
 * collapsed whitespace. Defensive — every transform is a no-op when
 * its pattern doesn't match, so a clean title passes through unchanged.
 */
export function sanitiseTitle(raw: string): string {
  let s = raw.trim();
  // LaTeX inline math wrappers: `$\mathrm{Foo}$`, `${Foo}$` → keep the
  // argument. Iterate so nested wrappers unwrap. Cap iterations to
  // avoid a pathological infinite-loop input.
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(/\$\\?[a-zA-Z]+\{([^${}]*)\}\$/g, "$1");
    s = s.replace(/\$\{([^${}]*)\}\$/g, "$1");
    s = s.replace(/\$([^$]+)\$/g, "$1");
    if (s === before) break;
  }
  // Markdown emphasis runs: keep the wrapped text, drop the markers.
  s = s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
  // Strip surrounding quotes (straight + curly).
  s = s.replace(/^["“'‘](.*)["”'’]$/, "$1");
  // Collapse internal whitespace runs.
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Extract a clean paper title from OCR'd markdown: the first non-empty
 * H1/H2 heading line, sanitised via `sanitiseTitle`. Returns null when
 * the markdown is empty/null or has no usable heading — callers decide
 * the fallback (corpus list → humanised source; .bib → "Untitled
 * paper" via the BibTeX builder).
 */
export function extractPaperTitle(markdown: string | null | undefined): string | null {
  if (!markdown) return null;
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^#{1,2}\s+(.+)$/);
    const heading = match?.[1] ? sanitiseTitle(match[1]) : "";
    if (heading.length > 0) return heading;
  }
  return null;
}

/**
 * Compact human-readable author string for a reference line:
 *   []                  → null
 *   ["A"]               → "A"
 *   ["A", "B"]          → "A, B"
 *   ["A", "B", "C", "D"]→ "A, B, et al." (cap at 3 then et al.)
 *
 * Exported for unit testing.
 */
export function formatAuthors(authors: string[] | null | undefined): string | null {
  if (!authors || authors.length === 0) return null;
  if (authors.length <= 3) return authors.join(", ");
  return `${authors.slice(0, 3).join(", ")}, et al.`;
}

/**
 * Build a one-line human-readable reference for the draft's References
 * appendix (the .md download). The `paperId` is the citation key the
 * draft cites with (= corpusItemId, see M98), so the line lets a reader
 * resolve `[<id>]` markers. Takes the same `DraftReference` shape the
 * on-page references use (M107) so the two surfaces share one input
 * contract.
 *
 * Shape (fields omitted when absent):
 *   - **[<id>]** Title — Authors (Year). Venue. https://doi.org/<doi>
 *
 * Exported for unit testing.
 */
export function formatReferenceLine(ref: {
  paperId: string;
  title: string | null;
  authors?: string[] | null;
  year?: number | null;
  venue?: string | null;
  externalDoi?: string | null;
  externalArxivId?: string | null;
}): string {
  const parts: string[] = [`- **[${ref.paperId}]**`];
  parts.push(ref.title ?? "Untitled paper");
  const authorStr = formatAuthors(ref.authors);
  const yearStr = ref.year != null ? `(${ref.year})` : null;
  // "— Authors (Year)" — join author + year with a space when both exist.
  const authorYear = [authorStr, yearStr].filter(Boolean).join(" ");
  if (authorYear) parts.push(`— ${authorYear}`);
  if (ref.venue) parts.push(`· ${ref.venue}`);
  let link: string | null = null;
  if (ref.externalDoi) link = `https://doi.org/${ref.externalDoi}`;
  else if (ref.externalArxivId) link = `https://arxiv.org/abs/${ref.externalArxivId}`;
  if (link) parts.push(`· ${link}`);
  return parts.join(" ");
}

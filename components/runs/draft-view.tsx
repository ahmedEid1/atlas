import ReactMarkdown from "react-markdown";
import { Card } from "@/components/ui/card";
import { formatAuthors } from "@/lib/paper-title";

/**
 * One reference for the on-page References section (M102). Mirrors the
 * .md download's appendix (M99) so the draft is self-contained
 * on-screen too — the inline `[corpusItemId]` markers are otherwise
 * opaque cuids.
 */
export type DraftReference = {
  paperId: string;
  title: string | null;
  authors?: string[] | null;
  year?: number | null;
  venue?: string | null;
  externalDoi?: string | null;
  externalArxivId?: string | null;
};

/**
 * Render the LLM-drafted SLR.
 *
 * The drafter (lib/prompts/draft-review.ts) is instructed to output Markdown
 * — `## H2` section headings, inline `[paper_id]` citations, prose paragraphs.
 * Previously this component wrapped the draft in `<pre>`, so users saw the
 * raw `## Background` and `[paper_001]` literals instead of formatted output.
 * Particularly bad on `/showcase`, the public exemplar that signed-out
 * visitors land on.
 *
 * Renders via `react-markdown` (no `rehype-raw` — keeps the safe default of
 * NOT executing HTML embedded in the LLM output, so a prompt-injection
 * attempt in an uploaded paper can't smuggle a <script> through). Each
 * element maps to Thoth-brand classes so the draft picks up the same
 * typographic system the rest of the site uses, without depending on
 * `@tailwindcss/typography`.
 *
 * `references` (optional): when provided, a References section renders
 * below the draft resolving the inline `[corpusItemId]` markers. Omitted
 * on the showcase page (read-only, no per-claim resolution).
 */
export function DraftView({
  draft,
  runId,
  references,
}: {
  draft: string;
  runId?: string;
  references?: DraftReference[];
}) {
  return (
    <Card className="p-6 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="eyebrow text-[var(--thoth-stone)]">Draft review</h2>
        {runId && (
          <div className="flex items-baseline gap-3">
            {/* `download` attribute intentionally bare — the server's
                Content-Disposition (M66) sets the friendly project-titled
                filename, and a bare `download` lets the browser honor it.
                Setting `download="thoth-<runId>..."` here would override
                the server's filename in same-origin requests. */}
            <a
              href={`/api/runs/${runId}/draft.md`}
              download
              className="text-xs text-[var(--thoth-stone)] hover:text-[var(--thoth-blue)] underline-offset-4 hover:underline transition-colors"
            >
              Download .md
            </a>
            <a
              href={`/api/runs/${runId}/citations.bib`}
              download
              className="text-xs text-[var(--thoth-stone)] hover:text-[var(--thoth-blue)] underline-offset-4 hover:underline transition-colors"
            >
              Download .bib
            </a>
          </div>
        )}
      </div>
      <div className="text-[var(--thoth-blue-ink)] leading-relaxed text-sm">
        {/* The page owns the single <h1> (project/run title) and the "Draft
            review" wrapper above is an <h2> section. The drafter LLM tends to
            put its review heading at H1, so demote every draft level by TWO to
            nest the draft content UNDER the "Draft review" h2 without skipping
            levels: # → h3, ## → h4, ### → h5, deeper → h6. Class names (visual
            sizes) are unchanged — only the semantic tag shifts, so the outline
            is correct for screen readers while the design is untouched. */}
        <ReactMarkdown
          components={{
            h1: ({ children }) => (
              <h3 className="font-display text-2xl text-[var(--thoth-blue-ink)] mt-6 mb-3 leading-tight">
                {children}
              </h3>
            ),
            h2: ({ children }) => (
              <h4 className="font-display text-xl text-[var(--thoth-blue-ink)] mt-6 mb-2 leading-tight">
                {children}
              </h4>
            ),
            h3: ({ children }) => (
              <h5 className="font-display text-lg text-[var(--thoth-blue-ink)] mt-4 mb-2 leading-tight">
                {children}
              </h5>
            ),
            h4: ({ children }) => (
              <h6 className="font-display text-base text-[var(--thoth-blue-ink)] mt-4 mb-2 leading-tight">
                {children}
              </h6>
            ),
            h5: ({ children }) => (
              <h6 className="font-display text-sm text-[var(--thoth-blue-ink)] mt-3 mb-2 leading-tight">
                {children}
              </h6>
            ),
            h6: ({ children }) => (
              <h6 className="font-display text-sm text-[var(--thoth-stone)] mt-3 mb-2 leading-tight">
                {children}
              </h6>
            ),
            p: ({ children }) => <p className="my-3">{children}</p>,
            ul: ({ children }) => <ul className="list-disc pl-6 my-3 space-y-1">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-6 my-3 space-y-1">{children}</ol>,
            li: ({ children }) => <li className="leading-snug">{children}</li>,
            // Inline `[paper_id]` references are emitted by the LLM as literal
            // bracketed strings — markdown does not parse them, so they appear
            // inside <p> as plain text. No special transform here; the
            // CitationFaithfulnessWidget below the draft is the real citation
            // surface.
            code: ({ children }) => (
              <code className="font-mono text-xs px-1 py-0.5 rounded bg-[var(--thoth-blue-mist)]/40">
                {children}
              </code>
            ),
            blockquote: ({ children }) => (
              <blockquote className="border-l-2 border-[var(--thoth-gold)] pl-4 my-3 text-[var(--thoth-stone)]">
                {children}
              </blockquote>
            ),
            a: ({ children, href }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
              >
                {children}
              </a>
            ),
          }}
        >
          {draft}
        </ReactMarkdown>
      </div>

      {references && references.length > 0 && (
        <section className="pt-2 border-t border-[var(--thoth-rule)]">
          <h3 className="font-display text-lg text-[var(--thoth-blue-ink)] mb-2">
            References
          </h3>
          <ul className="space-y-1.5 text-xs">
            {references.map((r) => {
              const authorStr = formatAuthors(r.authors);
              const link = r.externalDoi
                ? `https://doi.org/${r.externalDoi}`
                : r.externalArxivId
                  ? `https://arxiv.org/abs/${r.externalArxivId}`
                  : null;
              return (
                <li key={r.paperId} className="leading-snug">
                  <span className="font-mono text-[10px] text-[var(--thoth-blue)] bg-[var(--thoth-blue-mist)]/40 px-1 rounded">
                    [{r.paperId}]
                  </span>{" "}
                  <span className="text-[var(--thoth-blue-ink)]">{r.title ?? "Untitled paper"}</span>
                  {authorStr && <span className="text-[var(--thoth-stone)]"> — {authorStr}</span>}
                  {r.year != null && <span className="text-[var(--thoth-stone)]"> ({r.year})</span>}
                  {r.venue && <span className="text-[var(--thoth-stone)]"> · {r.venue}</span>}
                  {link && (
                    <>
                      {" · "}
                      <a
                        href={link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
                      >
                        {link.replace(/^https:\/\//, "")}
                      </a>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </Card>
  );
}

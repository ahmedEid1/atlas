/**
 * A single citation extracted from a draft. `paperId` is the value inside
 * the `[...]` mention; `claim` is the full sentence that contains the citation.
 */
export type ExtractedCitation = {
  paperId: string;
  claim: string;
};

// Anchor: `[word_chars]` — lowercase letters, digits, underscores, hyphens.
// Markdown link form `[text](url)` is rejected because we require word chars
// only inside the brackets and `(`/whitespace check after.
const CITATION_REGEX = /\[([a-z0-9_-]+)\]/gi;

// Sentence splitter: splits on `.`, `?`, `!` followed by whitespace or end-of-string.
// Keeps the terminator on the previous sentence.
function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s.length > 0) out.push(s);
  }
  return out;
}

/**
 * Parse all `[paper_id]` citations from a draft. For each citation, return the
 * surrounding sentence as the "claim". A sentence with two citations yields
 * two entries (one per citation), both with the same claim text.
 */
export function extractCitations(draft: string): ExtractedCitation[] {
  const sentences = splitSentences(draft);
  const results: ExtractedCitation[] = [];
  for (const sentence of sentences) {
    CITATION_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CITATION_REGEX.exec(sentence)) !== null) {
      // Reject markdown link form: `[text](url)` — check the next char after `]`.
      const after = sentence[m.index + m[0].length];
      if (after === "(") continue;
      const paperId = m[1];
      if (paperId === undefined) continue;
      results.push({ paperId, claim: sentence });
    }
  }
  return results;
}

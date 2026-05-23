/**
 * Atlas eval metrics. All return a score in [0, 1].
 * Vacuous-true convention: returns 1.0 when the "expected" set is empty so an
 * eval question that doesn't assert on this metric doesn't drag the average down.
 */

export function citationRecall(expected: string[], included: string[]): number {
  if (expected.length === 0) return 1;
  const inc = new Set(included);
  const hits = expected.filter((id) => inc.has(id)).length;
  return hits / expected.length;
}

export function citationPrecision(expected: string[], included: string[]): number {
  if (included.length === 0) return 1;
  const exp = new Set(expected);
  const hits = included.filter((id) => exp.has(id)).length;
  return hits / included.length;
}

export function claimFaithfulness(
  claimChecks: Array<{ verdict: "SUPPORTED" | "UNSUPPORTED" | "UNCLEAR" }>,
): number {
  if (claimChecks.length === 0) return 1;
  const supported = claimChecks.filter((c) => c.verdict === "SUPPORTED").length;
  return supported / claimChecks.length;
}

export function expectedClaimCoverage(expectedClaims: string[], draft: string): number {
  if (expectedClaims.length === 0) return 1;
  const haystack = draft.toLowerCase();
  const hits = expectedClaims.filter((c) => haystack.includes(c.toLowerCase())).length;
  return hits / expectedClaims.length;
}

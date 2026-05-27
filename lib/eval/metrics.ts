/**
 * Thoth eval metrics. All return a score in [0, 1].
 * Vacuous-true convention: returns 1.0 when the "expected" set is empty so an
 * eval question that doesn't assert on this metric doesn't drag the average down.
 */

export function citationRecall(expected: string[], included: string[]): number {
  if (expected.length === 0) return 1;
  const inc = new Set(included);
  const hits = expected.filter((id) => inc.has(id)).length;
  return hits / expected.length;
}

/**
 * V2 — `discovery_recall`. How many of the expected DOIs/arxiv ids did the
 * outbound discoverer surface? Matched against the union of every search
 * provider's hit list (after dedup), BEFORE the screener decides which to
 * include. This isolates the discoverer's job from screening + assessment
 * so a regression in either node localises here vs. downstream.
 */
export function discoveryRecall(
  expectedExternalIds: string[],
  discoveredExternalIds: string[],
): number {
  if (expectedExternalIds.length === 0) return 1;
  const found = new Set(discoveredExternalIds);
  const hits = expectedExternalIds.filter((id) => found.has(id)).length;
  return hits / expectedExternalIds.length;
}

/**
 * V2 — `screening_precision`. Of the papers the screener marked include=true,
 * how many were on the expected list? Penalises a too-loose screener that
 * waves marginally-relevant hits through.
 *
 * Returns 1 (vacuously true) when the screener admitted zero papers — same
 * convention as `citationPrecision`.
 */
export function screeningPrecision(
  expectedExternalIds: string[],
  screenedIncludeExternalIds: string[],
): number {
  if (screenedIncludeExternalIds.length === 0) return 1;
  const exp = new Set(expectedExternalIds);
  const hits = screenedIncludeExternalIds.filter((id) => exp.has(id)).length;
  return hits / screenedIncludeExternalIds.length;
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

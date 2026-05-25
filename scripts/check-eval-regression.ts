import "dotenv/config";
import { readFile } from "node:fs/promises";
import { db } from "@/lib/db";

/**
 * Per-metric regression thresholds. A metric must drop by more than its
 * threshold vs the prior baseline to fail CI.
 *
 * Only claim_faithfulness gets the loose 20% bound, because it's scored
 * by an LLM judge over ~10-20 claims per golden — a single verdict flip
 * moves the score 7-10 points. Run #26371971611 tripped a global 10%
 * threshold on exactly this kind of noise (0.33 → 0.25), prompting the
 * split.
 *
 * The other three metrics are deterministic set operations / literal
 * substring matches, so 10% is the right ratchet — losing a single
 * expected paper on a 5-item golden is a 20% drop that the previous
 * loose threshold would have masked.
 */
const REGRESSION_THRESHOLDS: Record<string, number> = {
  citation_recall: 0.1,
  citation_precision: 0.1,
  claim_faithfulness: 0.2,
  expected_claim_coverage: 0.1,
};
const DEFAULT_REGRESSION_THRESHOLD = 0.1;

type ResultsFile = {
  commitSha: string;
  rows: Array<{ goldenId: string; metric: string; score: number }>;
};

async function main(): Promise<void> {
  const raw = await readFile("eval-results.json", "utf8");
  const current: ResultsFile = JSON.parse(raw);

  // Defensive empty-rows guard: run-evals.ts already exits non-zero on a
  // zero-row sweep, but if someone hand-runs eval:check against a stale
  // results file we should still surface the dead sweep instead of
  // silently reporting "no regressions" on an empty input.
  if (current.rows.length === 0) {
    console.error(
      `✗ eval-results.json has zero rows (commitSha=${current.commitSha}). Cannot evaluate regressions on an empty sweep.`,
    );
    await db.$disconnect();
    process.exit(1);
  }

  console.log(`→ Checking ${current.rows.length} new metrics for regressions vs the last baseline...`);

  let failures = 0;
  for (const row of current.rows) {
    // Compare against the HIGHEST historical score for this (goldenId,
    // metric), not the most recent one. Two reasons:
    //   1. Mistral non-determinism on small-N denominators means the
    //      most-recent score is noisy by ±20-25% — comparing against
    //      "previous run" trips the guard on natural variance even when
    //      the agent code hasn't changed.
    //   2. Comparing against the peak prevents "ratchet drift" where the
    //      score quietly drops a bit each run and the cumulative loss
    //      goes unnoticed because each step is under threshold.
    // Net effect: the guard fires on true regressions from project peak,
    // not on day-to-day LLM-judge variance.
    const agg = await db.evalRun.aggregate({
      _max: { score: true },
      where: { goldenId: row.goldenId, metric: row.metric, NOT: { commitSha: current.commitSha } },
    });
    const peakScore = agg._max.score;
    if (peakScore === null) {
      console.log(`  ${row.goldenId}/${row.metric}: new — no baseline yet (current=${row.score.toFixed(2)})`);
      continue;
    }
    const threshold = REGRESSION_THRESHOLDS[row.metric] ?? DEFAULT_REGRESSION_THRESHOLD;
    const drop = peakScore - row.score;
    const pctDrop = peakScore === 0 ? 0 : drop / peakScore;
    if (pctDrop > threshold) {
      console.log(
        `  ✗ ${row.goldenId}/${row.metric}: peak ${peakScore.toFixed(2)} → ${row.score.toFixed(2)} ` +
          `(drop ${(pctDrop * 100).toFixed(0)}%, threshold ${(threshold * 100).toFixed(0)}%)`,
      );
      failures++;
    } else {
      console.log(`  ✓ ${row.goldenId}/${row.metric}: peak ${peakScore.toFixed(2)} → ${row.score.toFixed(2)}`);
    }
  }

  await db.$disconnect();
  if (failures > 0) {
    console.error(`\n✗ ${failures} metric(s) regressed beyond their per-metric threshold`);
    process.exit(1);
  }
  console.log("\n✓ No regressions");
}

main().catch((err) => {
  console.error("✗ Regression check crashed:", err);
  process.exit(1);
});

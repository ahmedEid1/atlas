import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { loadGolden } from "@/lib/eval/golden-loader";
import { seedEvalProject } from "@/lib/eval/seed-corpus";
import { runHeadless } from "@/lib/eval/headless-runner";
import {
  citationRecall,
  citationPrecision,
  claimFaithfulness,
  expectedClaimCoverage,
} from "@/lib/eval/metrics";
import { db } from "@/lib/db";
import { createRun, persistIncludedPapers, persistClaims, finishRun } from "@/lib/agent/runs";

type MetricRow = {
  goldenId: string;
  metric: "citation_recall" | "citation_precision" | "claim_faithfulness" | "expected_claim_coverage";
  score: number;
};

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return process.env.GITHUB_SHA ?? "unknown";
  }
}

/**
 * EVAL_GOLDENS: optional CSV of golden ids (e.g. "000,001,005"). Matched against
 * each golden's leading id prefix (everything before the first "-"), so users
 * don't have to type the full slug. Unset/empty = run every golden in evals/golden/.
 */
function selectGoldens<T extends { id: string }>(all: T[]): T[] {
  const raw = process.env.EVAL_GOLDENS?.trim();
  if (!raw) return all;
  const wanted = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return all.filter((g) => wanted.has(g.id.split("-")[0] ?? g.id));
}

/**
 * EVAL_GOLDEN_TIMEOUT_MS: per-golden walltime cap. Default 15 minutes. A golden
 * that exceeds this is logged + skipped (no EvalRun rows written for it); the
 * sweep continues with the next golden. Bound is necessary because the cron's
 * Mistral provider can stall on free-tier rate-limits and one stuck golden
 * shouldn't burn the whole CI budget. Tuned to 15 min after run #26371971611
 * showed 4/6 goldens hitting the previous 8-min cap — the agent's cite-check
 * loop under Mistral throttling routinely needs 10-12 min.
 */
const DEFAULT_GOLDEN_TIMEOUT_MS = 15 * 60 * 1000;
function goldenTimeoutMs(): number {
  const raw = process.env.EVAL_GOLDEN_TIMEOUT_MS;
  if (!raw) return DEFAULT_GOLDEN_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GOLDEN_TIMEOUT_MS;
}

async function main(): Promise<void> {
  console.log("→ Loading golden questions...");
  const allGolden = await loadGolden();
  const golden = selectGoldens(allGolden);
  console.log(
    `  ${golden.length} of ${allGolden.length} selected${
      process.env.EVAL_GOLDENS ? ` (EVAL_GOLDENS=${process.env.EVAL_GOLDENS})` : ""
    }`,
  );

  if (golden.length === 0) {
    console.error(
      allGolden.length === 0
        ? "✗ No golden questions found in evals/golden/. Add some YAMLs."
        : `✗ EVAL_GOLDENS=${process.env.EVAL_GOLDENS} matched zero of ${allGolden.length} goldens.`,
    );
    process.exit(1);
  }

  const commitSha = gitSha();
  const allRows: MetricRow[] = [];
  const perGoldenTimeout = goldenTimeoutMs();

  for (const g of golden) {
    console.log(`\n→ ${g.id}: "${g.question.slice(0, 60)}..."`);
    const t0 = Date.now();
    const seed = await seedEvalProject(g);
    const run = await createRun({ projectId: seed.projectId, question: g.question });

    let result;
    try {
      const TIMEOUT = Symbol("golden-timeout");
      const runPromise = runHeadless({
        runId: run.id,
        projectId: seed.projectId,
        question: g.question,
        corpusItemIds: seed.corpusItemIds,
      });
      const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) =>
        setTimeout(() => resolve(TIMEOUT), perGoldenTimeout),
      );
      const raced = await Promise.race([runPromise, timeoutPromise]);
      if (raced === TIMEOUT) {
        console.error(
          `  ✗ exceeded per-golden walltime cap (${Math.round(perGoldenTimeout / 1000)}s); skipping`,
        );
        continue;
      }
      result = raced;
    } catch (err) {
      console.error(`  ✗ run failed: ${(err as Error).message}`);
      continue;
    }

    // Translate Thoth's CorpusItem ids back to the YAML's paper ids so metrics line up
    const corpusToPaperId = new Map(Object.entries(seed.paperIdMap).map(([y, c]) => [c, y]));
    const includedPaperIds = result.includedPapers
      .map((p) => corpusToPaperId.get(p.corpusItemId))
      .filter((id): id is string => id !== undefined);

    // cite_check writes rows asynchronously; fetch them
    const claimChecks = await db.claimCheck.findMany({ where: { runId: run.id } });

    const metrics: MetricRow[] = [
      { goldenId: g.id, metric: "citation_recall",          score: citationRecall(g.expectedPapers, includedPaperIds) },
      { goldenId: g.id, metric: "citation_precision",       score: citationPrecision(g.expectedPapers, includedPaperIds) },
      { goldenId: g.id, metric: "claim_faithfulness",       score: claimFaithfulness(claimChecks) },
      { goldenId: g.id, metric: "expected_claim_coverage",  score: expectedClaimCoverage(g.expectedClaims, result.draft ?? "") },
    ];
    allRows.push(...metrics);

    // Persist EvalRun rows
    await db.evalRun.createMany({
      data: metrics.map((m) => ({
        goldenId: m.goldenId,
        metric: m.metric,
        score: m.score,
        runId: run.id,
        commitSha,
      })),
    });

    // Finalize the Thoth Run (for visibility in /projects/* if anyone looks)
    if (result.draft) await finishRun({ runId: run.id, draft: result.draft });
    if (result.includedPapers.length > 0) await persistIncludedPapers({ runId: run.id, included: result.includedPapers });
    if (result.claims.length > 0) await persistClaims({ runId: run.id, claims: result.claims });

    const summary = metrics.map((m) => `${m.metric}=${m.score.toFixed(2)}`).join("  ");
    console.log(`  ${summary}   (${Date.now() - t0}ms)`);
  }

  await writeFile("eval-results.json", JSON.stringify({ commitSha, rows: allRows }, null, 2));
  console.log(`\n✓ Wrote eval-results.json (${allRows.length} rows)`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error("✗ Eval run failed:", err);
  process.exit(1);
});

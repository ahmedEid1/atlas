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

async function main(): Promise<void> {
  console.log("→ Loading golden questions...");
  const golden = await loadGolden();
  console.log(`  ${golden.length} loaded`);

  if (golden.length === 0) {
    console.error("✗ No golden questions found in evals/golden/. Add some YAMLs.");
    process.exit(1);
  }

  const commitSha = gitSha();
  const allRows: MetricRow[] = [];

  for (const g of golden) {
    console.log(`\n→ ${g.id}: "${g.question.slice(0, 60)}..."`);
    const t0 = Date.now();
    const seed = await seedEvalProject(g);
    const run = await createRun({ projectId: seed.projectId, question: g.question });

    let result;
    try {
      result = await runHeadless({
        runId: run.id,
        projectId: seed.projectId,
        question: g.question,
        corpusItemIds: seed.corpusItemIds,
      });
    } catch (err) {
      console.error(`  ✗ run failed: ${(err as Error).message}`);
      continue;
    }

    // Translate Atlas's CorpusItem ids back to the YAML's paper ids so metrics line up
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

    // Finalize the Atlas Run (for visibility in /projects/* if anyone looks)
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

import { db } from "@/lib/db";
import { MetricCard } from "@/components/evals/MetricCard";
import { QuestionRow } from "@/components/evals/QuestionRow";

export const dynamic = "force-dynamic"; // always fresh

const METRICS = [
  { key: "citation_recall",         label: "Citation recall" },
  { key: "citation_precision",      label: "Citation precision" },
  { key: "claim_faithfulness",      label: "Claim faithfulness" },
  { key: "expected_claim_coverage", label: "Expected-claim coverage" },
] as const;

export default async function EvalsPage() {
  // Latest score per (goldenId, metric)
  const rows = await db.evalRun.findMany({
    orderBy: { createdAt: "desc" },
  });

  const latestByKey = new Map<string, { score: number; createdAt: Date }>();
  for (const r of rows) {
    const k = `${r.goldenId}::${r.metric}`;
    if (!latestByKey.has(k)) latestByKey.set(k, { score: r.score, createdAt: r.createdAt });
  }

  // Aggregate per metric (average across goldens)
  const aggregate: Record<string, number> = {};
  for (const m of METRICS) {
    const scores = Array.from(latestByKey.entries())
      .filter(([k]) => k.endsWith(`::${m.key}`))
      .map(([, v]) => v.score);
    aggregate[m.key] = scores.length === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  // Per-question latest row
  const goldenIds = Array.from(new Set(rows.map((r) => r.goldenId))).sort();
  const perQuestion = goldenIds.map((id) => ({
    goldenId: id,
    scores: {
      recall:       latestByKey.get(`${id}::citation_recall`)?.score        ?? 0,
      precision:    latestByKey.get(`${id}::citation_precision`)?.score     ?? 0,
      faithfulness: latestByKey.get(`${id}::claim_faithfulness`)?.score     ?? 0,
      coverage:     latestByKey.get(`${id}::expected_claim_coverage`)?.score ?? 0,
    },
  }));

  const lastRun = rows[0];

  return (
    <main className="max-w-5xl mx-auto p-8">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold">Atlas evals</h1>
        <p className="text-gray-600 mt-2">
          Public eval dashboard. {goldenIds.length} golden SLR questions, 4 metrics, runs nightly + on every push to master.
        </p>
        {lastRun && (
          <p className="text-xs text-gray-500 mt-1">
            Last run: {lastRun.createdAt.toISOString()} (commit{" "}
            <code className="font-mono">{lastRun.commitSha.slice(0, 7)}</code>)
          </p>
        )}
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {METRICS.map((m) => (
          <MetricCard key={m.key} label={m.label} value={aggregate[m.key] ?? 0} />
        ))}
      </section>

      <section className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left">
              <th className="py-2 px-3">Question</th>
              <th className="py-2 px-3 text-right">Recall</th>
              <th className="py-2 px-3 text-right">Precision</th>
              <th className="py-2 px-3 text-right">Faithfulness</th>
              <th className="py-2 px-3 text-right">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {perQuestion.length === 0 && (
              <tr><td colSpan={5} className="py-6 px-3 text-center text-gray-500">No eval runs yet. See <a href="https://github.com/ahmedEid1/atlas/tree/master/evals" className="text-blue-600 hover:underline">evals/README.md</a> for current status (known upstream LLM-SDK issue blocking first run).</td></tr>
            )}
            {perQuestion.map((p) => (
              <QuestionRow key={p.goldenId} goldenId={p.goldenId} scores={p.scores} />
            ))}
          </tbody>
        </table>
      </section>

      <footer className="mt-8 text-xs text-gray-500">
        Source: <a href="https://github.com/ahmedEid1/atlas/tree/master/evals" className="text-blue-600 hover:underline">evals/</a> on GitHub.
        Methodology in <code className="font-mono">docs/superpowers/specs/2026-05-23-m4-critic-cite-check-evals-design.md</code>.
      </footer>
    </main>
  );
}

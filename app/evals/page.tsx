import { db } from "@/lib/db";
import { MetricCard } from "@/components/evals/MetricCard";
import { QuestionRow } from "@/components/evals/QuestionRow";

export const dynamic = "force-dynamic"; // always fresh

const METRICS = [
  { key: "citation_recall", label: "Citation recall" },
  { key: "citation_precision", label: "Citation precision" },
  { key: "claim_faithfulness", label: "Claim faithfulness" },
  { key: "expected_claim_coverage", label: "Expected-claim coverage" },
] as const;

export default async function EvalsPage() {
  // Latest score per (goldenId, metric)
  const rows = await db.evalRun.findMany({ orderBy: { createdAt: "desc" } });

  const latestByKey = new Map<string, { score: number; createdAt: Date }>();
  for (const r of rows) {
    const k = `${r.goldenId}::${r.metric}`;
    if (!latestByKey.has(k))
      latestByKey.set(k, { score: r.score, createdAt: r.createdAt });
  }

  // Aggregate per metric (average across goldens)
  const aggregate: Record<string, number> = {};
  for (const m of METRICS) {
    const scores = Array.from(latestByKey.entries())
      .filter(([k]) => k.endsWith(`::${m.key}`))
      .map(([, v]) => v.score);
    aggregate[m.key] =
      scores.length === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  // Per-question latest row
  const goldenIds = Array.from(new Set(rows.map((r) => r.goldenId))).sort();
  const perQuestion = goldenIds.map((id) => ({
    goldenId: id,
    scores: {
      recall: latestByKey.get(`${id}::citation_recall`)?.score ?? 0,
      precision: latestByKey.get(`${id}::citation_precision`)?.score ?? 0,
      faithfulness: latestByKey.get(`${id}::claim_faithfulness`)?.score ?? 0,
      coverage: latestByKey.get(`${id}::expected_claim_coverage`)?.score ?? 0,
    },
  }));

  const lastRun = rows[0];
  const lastRunDate = lastRun
    ? new Date(lastRun.createdAt).toLocaleString("en-GB", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
        timeZoneName: "short",
      })
    : null;

  return (
    <main id="main" className="max-w-6xl mx-auto px-6 py-16">
      {/* EDITORIAL HEADER ────────────────────────────────────────────── */}
      <header className="mb-14 max-w-3xl">
        <p className="eyebrow">Public Eval Dashboard</p>
        <h1
          className="font-display text-[var(--thoth-blue-ink)] mt-4 leading-[1.0] tracking-tight"
          style={{
            fontSize: "clamp(2.5rem, 6vw, 4rem)",
            fontWeight: 500,
            fontVariationSettings: "'opsz' 96",
          }}
        >
          Citation evaluation, in public.
        </h1>
        <p className="mt-5 text-lg text-[var(--thoth-blue-ink)] max-w-2xl leading-relaxed">
          {goldenIds.length} golden SLR question{goldenIds.length === 1 ? "" : "s"},
          4 metrics, the latest commit-of-record run for each. Designed so a
          regression is a public signal — not a hidden one.
        </p>
        {lastRunDate && lastRun && (
          <p className="mt-4 text-sm text-[var(--thoth-stone)] flex flex-wrap items-center gap-2">
            <span>Last run</span>
            <time className="text-[var(--thoth-blue-ink)] tabular-nums">
              {lastRunDate}
            </time>
            <span aria-hidden="true">·</span>
            <span>commit</span>
            <code className="font-mono text-[0.85em] text-[var(--thoth-blue)] bg-[var(--thoth-blue-mist)]/40 px-1.5 py-0.5 rounded">
              {lastRun.commitSha.slice(0, 7)}
            </code>
          </p>
        )}
      </header>

      {/* AGGREGATE METRICS ───────────────────────────────────────────── */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-16">
        {METRICS.map((m) => (
          <MetricCard
            key={m.key}
            label={m.label}
            value={aggregate[m.key] ?? 0}
          />
        ))}
      </section>

      {/* PER-QUESTION TABLE ─────────────────────────────────────────── */}
      <section className="mb-12">
        <div className="flex items-baseline justify-between mb-5">
          <h2 className="font-display text-2xl font-medium text-[var(--thoth-blue-ink)]">
            By question
          </h2>
          <p className="text-xs text-[var(--thoth-stone)]">
            Most recent run per (question × metric).
          </p>
        </div>
        <div className="bg-[oklch(1_0_0)] border border-[var(--thoth-rule)] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--thoth-blue-mist)]/30 border-b border-[var(--thoth-rule)]">
                <th className="py-3 px-4 text-left text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-[var(--thoth-stone)]">
                  Question
                </th>
                <th className="py-3 px-4 text-right text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-[var(--thoth-stone)]">
                  Recall
                </th>
                <th className="py-3 px-4 text-right text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-[var(--thoth-stone)]">
                  Precision
                </th>
                <th className="py-3 px-4 text-right text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-[var(--thoth-stone)]">
                  Faithfulness
                </th>
                <th className="py-3 px-4 text-right text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-[var(--thoth-stone)]">
                  Coverage
                </th>
              </tr>
            </thead>
            <tbody>
              {perQuestion.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="py-10 px-4 text-center text-sm text-[var(--thoth-stone)]"
                  >
                    No eval runs yet. See{" "}
                    <a
                      href="https://github.com/ahmedEid1/thoth/tree/master/evals"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
                    >
                      evals/README.md
                    </a>{" "}
                    for current status.
                  </td>
                </tr>
              )}
              {perQuestion.map((p) => (
                <QuestionRow
                  key={p.goldenId}
                  goldenId={p.goldenId}
                  scores={p.scores}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* METHODOLOGY ────────────────────────────────────────────────── */}
      <footer className="rule pt-8 text-xs text-[var(--thoth-stone)] flex flex-wrap gap-x-6 gap-y-2">
        <span>
          Source ·{" "}
          <a
            href="https://github.com/ahmedEid1/thoth/tree/master/evals"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
          >
            evals/
          </a>
        </span>
        <span>
          Methodology ·{" "}
          <a
            href="https://github.com/ahmedEid1/thoth/blob/master/docs/superpowers/specs/2026-05-23-m4-critic-cite-check-evals-design.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
          >
            M4 design spec
          </a>
        </span>
        <span>
          Headless runner ·{" "}
          <code className="font-mono text-[var(--thoth-blue-ink)]">
            lib/eval/headless-runner.ts
          </code>
        </span>
      </footer>
    </main>
  );
}

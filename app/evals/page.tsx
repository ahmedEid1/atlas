import { readdir } from "node:fs/promises";
import { db } from "@/lib/db";
import { MetricCard } from "@/components/evals/MetricCard";
import { QuestionRow } from "@/components/evals/QuestionRow";

export const dynamic = "force-dynamic"; // always fresh

/**
 * Count the YAML files under evals/golden/ so we can render a
 * "X of Y goldens completed in latest sweep" badge. Filesystem read is
 * cheap and always reflects the repo state at the running deploy.
 */
async function countGoldenYamls(): Promise<number> {
  try {
    const files = await readdir("evals/golden");
    return files.filter((f) => f.endsWith(".yaml")).length;
  } catch {
    return 0;
  }
}

const METRICS = [
  {
    key: "citation_recall",
    label: "Citation recall",
    short: "Did the agent find the papers it should have?",
  },
  {
    key: "citation_precision",
    label: "Citation precision",
    short: "Of the papers it cited, how many were the right ones?",
  },
  {
    key: "claim_faithfulness",
    label: "Claim faithfulness",
    short: "Are its claims actually supported by the papers it cites?",
  },
  {
    key: "expected_claim_coverage",
    label: "Expected-claim coverage",
    short: "Does the draft mention the canonical findings reviewers expect?",
  },
  {
    key: "discovery_recall",
    label: "Discovery recall (v2)",
    short: "For outbound runs: did the discoverer find the expected papers across providers?",
  },
  {
    key: "screening_precision",
    label: "Screening precision (v2)",
    short: "Of the papers the screener admitted, what fraction were the expected ones?",
  },
] as const;

export default async function EvalsPage() {
  // Latest score per (goldenId, metric)
  const rows = await db.evalRun.findMany({ orderBy: { createdAt: "desc" } });
  const totalYamls = await countGoldenYamls();

  // Count goldens with at least one row at the latest commitSha — that's
  // how many actually completed in the most recent sweep. Surfacing this
  // catches silent partial runs (rate-limit skips, walltime timeouts) so
  // a half-completed sweep is visible publicly, not hidden in CI logs.
  const latestCommit = rows[0]?.commitSha;
  const completedInLatestSweep = latestCommit
    ? new Set(rows.filter((r) => r.commitSha === latestCommit).map((r) => r.goldenId)).size
    : 0;

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
          {/* Prefer totalYamls — the canonical golden set on disk in
              evals/golden/ — over goldenIds.length, which is the subset that
              has any EvalRun history yet. With the cron-default 6-golden
              smoke set, goldenIds.length drifts under the canonical 17 until
              a workflow_dispatch with goldens=all runs the rest. The "X of Y
              goldens have data at this commit" badge below clarifies that
              distinction. Falling back to goldenIds.length keeps the page
              honest if evals/golden/ readdir fails (totalYamls === 0). */}
          {(totalYamls > 0 ? totalYamls : goldenIds.length)} golden SLR question
          {(totalYamls > 0 ? totalYamls : goldenIds.length) === 1 ? "" : "s"},
          4 metrics, the latest commit-of-record run for each. Designed so a
          regression is a public signal — not a hidden one.
        </p>
        {lastRunDate && lastRun && (
          <p className="mt-4 text-sm text-[var(--thoth-stone)] flex flex-wrap items-center gap-2">
            <span>Last run</span>
            <time
              dateTime={new Date(lastRun.createdAt).toISOString()}
              className="text-[var(--thoth-blue-ink)] tabular-nums"
            >
              {lastRunDate}
            </time>
            <span aria-hidden="true">·</span>
            <span>commit</span>
            <code className="font-mono text-[0.85em] text-[var(--thoth-blue)] bg-[var(--thoth-blue-mist)]/40 px-1.5 py-0.5 rounded">
              {lastRun.commitSha.slice(0, 7)}
            </code>
            {totalYamls > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span
                  className={
                    completedInLatestSweep === totalYamls
                      ? "text-[var(--thoth-blue-ink)]"
                      : "text-[var(--thoth-stone)]"
                  }
                  title={
                    completedInLatestSweep === totalYamls
                      ? "Every golden in evals/golden/ has a metric row at the most recent commit."
                      : "Goldens write a row only when their agent run completes. A golden may have no row at this commit because it wasn't included in the latest sweep (the cron runs a smoke subset) or because the run hit a rate-limit or walltime cap."
                  }
                >
                  <span className="tabular-nums">{completedInLatestSweep}</span>
                  <span> of </span>
                  <span className="tabular-nums">{totalYamls}</span>
                  <span> goldens have data at this commit</span>
                </span>
              </>
            )}
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
            description={m.short}
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

      {/* HOW THIS WORKS ─────────────────────────────────────────────── */}
      <section className="mb-16">
        <div className="mb-6">
          <h2 className="font-display text-2xl font-medium text-[var(--thoth-blue-ink)]">
            How this works
          </h2>
          <p className="mt-2 text-sm text-[var(--thoth-stone)] max-w-2xl leading-relaxed">
            Why the dashboard exists, how a number gets here, and what each
            metric is actually measuring.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 mb-8">
          <article className="bg-[oklch(1_0_0)] border border-[var(--thoth-rule)] rounded-lg p-6">
            <p className="eyebrow mb-3">Lifecycle</p>
            <ol className="space-y-3 text-sm text-[var(--thoth-ink)] leading-relaxed list-decimal list-outside ml-5">
              <li>
                Each golden lives in{" "}
                <code className="font-mono text-[0.85em] text-[var(--thoth-blue)]">
                  evals/golden/*.yaml
                </code>{" "}
                — a question, a small expected corpus, and a list of claims
                a competent reviewer would surface.
              </li>
              <li>
                A scheduled GitHub Action (Monday 06:00 UTC, also manually
                triggerable) runs the full Thoth agent loop —{" "}
                <em>plan → retrieve → assess → draft → cite-check</em> —
                headlessly against every golden.
              </li>
              <li>
                Each run writes one row per{" "}
                <code className="font-mono text-[0.85em] text-[var(--thoth-blue)]">
                  (golden, metric)
                </code>{" "}
                to the{" "}
                <code className="font-mono text-[0.85em] text-[var(--thoth-blue)]">
                  EvalRun
                </code>{" "}
                table. This page reads the latest row for each pair — no
                cherry-picking, no averaging across history.
              </li>
            </ol>
          </article>

          <article className="bg-[oklch(1_0_0)] border border-[var(--thoth-rule)] rounded-lg p-6">
            <p className="eyebrow mb-3">Philosophy</p>
            <dl className="space-y-3 text-sm text-[var(--thoth-ink)] leading-relaxed">
              <div>
                <dt className="font-semibold text-[var(--thoth-blue-ink)]">
                  Public, not hidden.
                </dt>
                <dd>
                  If a commit makes the agent worse, the regression shows up
                  here — not buried in CI logs only the author reads.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-[var(--thoth-blue-ink)]">
                  Vacuous-true scoring.
                </dt>
                <dd>
                  When a golden doesn&apos;t assert on a particular metric
                  (no expected papers, no expected claims), that metric
                  returns 1.0 for that golden so it doesn&apos;t drag the
                  average down.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-[var(--thoth-blue-ink)]">
                  Advisory regression watch.
                </dt>
                <dd>
                  Each metric is logged with its delta from the
                  highest historical score for that golden, but the
                  check is <em>advisory</em>, not a CI gate. Empirical
                  result: Mistral&apos;s free-tier non-determinism on
                  4–5-item denominators produces ±25–40% per-metric
                  variance run-to-run even when agent code is
                  byte-identical, so no single threshold cleanly
                  separates real regressions from sampling noise. The
                  dashboard is the authoritative public signal; the
                  workflow status reflects only catastrophic failure
                  (empty sweep, infrastructure outage).
                </dd>
              </div>
            </dl>
          </article>
        </div>

        {/* Per-metric definitions */}
        <div className="bg-[oklch(1_0_0)] border border-[var(--thoth-rule)] rounded-lg p-6">
          <p className="eyebrow mb-4">The four metrics, in detail</p>
          <dl className="space-y-5 text-sm text-[var(--thoth-ink)] leading-relaxed">
            <div>
              <dt className="font-display text-base font-medium text-[var(--thoth-blue-ink)]">
                Citation recall ·{" "}
                <span className="font-mono text-xs text-[var(--thoth-stone)]">
                  expected ∩ cited / expected
                </span>
              </dt>
              <dd className="mt-1">
                Of the papers the golden says should be cited, how many did
                the agent actually surface? Hardest metric to game — it
                requires retrieval and screening to land on the right
                papers from the corpus, not just write plausible prose.
              </dd>
            </div>
            <div>
              <dt className="font-display text-base font-medium text-[var(--thoth-blue-ink)]">
                Citation precision ·{" "}
                <span className="font-mono text-xs text-[var(--thoth-stone)]">
                  expected ∩ cited / cited
                </span>
              </dt>
              <dd className="mt-1">
                Of the papers the agent did cite, how many were on the
                expected list? Easy to score 100% by being maximally
                conservative; the trick is doing it{" "}
                <em>alongside</em> high recall.
              </dd>
            </div>
            <div>
              <dt className="font-display text-base font-medium text-[var(--thoth-blue-ink)]">
                Claim faithfulness ·{" "}
                <span className="font-mono text-xs text-[var(--thoth-stone)]">
                  SUPPORTED / total claim checks
                </span>
              </dt>
              <dd className="mt-1">
                After drafting, the cite-check stage asks an LLM whether
                each extracted claim is actually supported by the paper
                excerpt it cites. This is the most direct measure of
                hallucination — and the metric we watch most closely.
              </dd>
            </div>
            <div>
              <dt className="font-display text-base font-medium text-[var(--thoth-blue-ink)]">
                Expected-claim coverage ·{" "}
                <span className="font-mono text-xs text-[var(--thoth-stone)]">
                  keyword hits / expected claims
                </span>
              </dt>
              <dd className="mt-1">
                Literal substring match: does the draft contain each
                expected-claim phrase from the golden? Deliberately
                brittle — paraphrasing scores zero — but useful for
                catching outright omissions of canonical findings.
                Treat low scores here as a prompt for inspection, not as
                proof of failure.
              </dd>
            </div>
          </dl>
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
            href="https://github.com/ahmedEid1/thoth/blob/master/docs/superpowers/specs/thoth-design.md#8-eval-harness"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
          >
            Design — eval harness
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

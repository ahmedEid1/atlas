/**
 * Server-component badge showing the run's token consumption against
 * the deploy's MAX_TOKENS_PER_RUN ceiling.
 *
 * cost-cap.ts trips BudgetExceededError when total in+out tokens
 * across all RunSteps exceeds env.MAX_TOKENS_PER_RUN. Visualising
 * that progress on the run-detail page lets researchers see, at a
 * glance, how much of the budget each review consumed — and on a
 * free-tier deploy, how many more runs they can fit before hitting
 * provider quotas.
 *
 * Color thresholds:
 *   <50% — neutral stone (plenty of headroom)
 *   50–80% — papyrus + gold (heading toward the cap)
 *   >80% — brick warn (close to BudgetExceededError)
 *
 * Cache-read tokens are NOT counted toward the budget — `cost-cap.ts`
 * sums in + out only — so they're shown separately when present.
 */
type Step = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
};

export function TokenSpendBadge({
  steps,
  budget,
}: {
  steps: Step[];
  budget: number;
}) {
  const totalIn = steps.reduce((sum, s) => sum + s.inputTokens, 0);
  const totalOut = steps.reduce((sum, s) => sum + s.outputTokens, 0);
  const totalCache = steps.reduce((sum, s) => sum + s.cacheReadInputTokens, 0);
  const billable = totalIn + totalOut;
  const pct = budget > 0 ? Math.round((billable / budget) * 100) : 0;

  const colour =
    pct >= 80
      ? "text-[var(--thoth-warn)] bg-[color-mix(in_oklab,var(--thoth-warn)_10%,var(--thoth-papyrus))] border-[var(--thoth-warn)]/30"
      : pct >= 50
        ? "text-[var(--thoth-blue-ink)] bg-[color-mix(in_oklab,var(--thoth-gold)_18%,var(--thoth-papyrus))] border-[var(--thoth-gold)]/30"
        : "text-[var(--thoth-stone)] bg-[var(--thoth-papyrus)] border-[var(--thoth-rule)]";

  // Format large numbers as `121k` rather than `121,463` so the badge
  // stays compact next to the status pill.
  const compact = (n: number): string =>
    n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n.toLocaleString();

  return (
    <span
      className={`inline-flex items-baseline gap-2 px-2 py-1 text-[10px] font-mono rounded border ${colour}`}
      title={`Billable: ${billable.toLocaleString()} of ${budget.toLocaleString()} tokens (in ${totalIn.toLocaleString()} · out ${totalOut.toLocaleString()}${totalCache > 0 ? ` · cache ${totalCache.toLocaleString()}` : ""})`}
    >
      <span>{compact(billable)} / {compact(budget)} tk</span>
      <span className="opacity-70">{pct}%</span>
    </span>
  );
}

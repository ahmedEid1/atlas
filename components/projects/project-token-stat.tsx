import { compactCount } from "@/lib/format";

/**
 * Project-level token-usage stat. Shows aggregate input + output tokens
 * across every RunStep of every run owned by the project. Cache-read
 * tokens are excluded from the headline number (matching the per-run
 * budget rules in cost-cap.ts) but appear in the tooltip when present.
 *
 * Lives alongside the project header rather than the per-run
 * TokenSpendBadge: the per-run badge is gated against
 * `MAX_TOKENS_PER_RUN`, the project stat is purely informational
 * ("how much did this project cost overall") — there's no project-
 * level cap.
 *
 * Hidden entirely when the project has no tokens to report (fresh
 * project, no runs yet).
 */
export function ProjectTokenStat({
  tokens,
}: {
  tokens: { in: number; out: number; cache: number };
}) {
  const billable = tokens.in + tokens.out;
  if (billable === 0) return null;

  const tooltip = `Total tokens across all runs: in ${tokens.in.toLocaleString("en-US")} · out ${tokens.out.toLocaleString("en-US")}${
    tokens.cache > 0 ? ` · cache ${tokens.cache.toLocaleString("en-US")}` : ""
  }`;

  return (
    <span
      className="inline-flex items-baseline gap-2 px-2 py-1 text-[10px] font-mono rounded border text-[var(--thoth-stone)] bg-[var(--thoth-papyrus)] border-[var(--thoth-rule)]"
      title={tooltip}
    >
      <span>{compactCount(billable)} tk total</span>
    </span>
  );
}

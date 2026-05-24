export type QuestionRowProps = {
  goldenId: string;
  scores: {
    recall: number;
    precision: number;
    faithfulness: number;
    coverage: number;
  };
};

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * One row of the public eval table. Monospace question id, tabular
 * numerals for the four scores, subtle hover. Reads like a row from a
 * published research-results table.
 */
export function QuestionRow({ goldenId, scores }: QuestionRowProps) {
  return (
    <tr className="border-b border-[var(--thoth-rule)] last:border-b-0 hover:bg-[var(--thoth-blue-mist)]/30 transition-colors">
      <td className="py-3 px-4 font-mono text-xs text-[var(--thoth-blue-ink)]">
        {goldenId}
      </td>
      <td className="py-3 px-4 text-right tabular-nums text-[var(--thoth-ink)]">
        {pct(scores.recall)}
      </td>
      <td className="py-3 px-4 text-right tabular-nums text-[var(--thoth-ink)]">
        {pct(scores.precision)}
      </td>
      <td className="py-3 px-4 text-right tabular-nums text-[var(--thoth-ink)]">
        {pct(scores.faithfulness)}
      </td>
      <td className="py-3 px-4 text-right tabular-nums text-[var(--thoth-ink)]">
        {pct(scores.coverage)}
      </td>
    </tr>
  );
}

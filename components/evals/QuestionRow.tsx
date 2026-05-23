export type QuestionRowProps = {
  goldenId: string;
  scores: { recall: number; precision: number; faithfulness: number; coverage: number };
};

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function QuestionRow({ goldenId, scores }: QuestionRowProps) {
  return (
    <tr className="border-b">
      <td className="py-2 px-3 font-mono text-xs">{goldenId}</td>
      <td className="py-2 px-3 text-right">{pct(scores.recall)}</td>
      <td className="py-2 px-3 text-right">{pct(scores.precision)}</td>
      <td className="py-2 px-3 text-right">{pct(scores.faithfulness)}</td>
      <td className="py-2 px-3 text-right">{pct(scores.coverage)}</td>
    </tr>
  );
}

"use client";

export type CritiquePanelProps = {
  critiqueScore: number | null;
};

export function CritiquePanel({ critiqueScore }: CritiquePanelProps) {
  if (critiqueScore == null) return null;
  const color =
    critiqueScore >= 4.5 ? "text-green-600 bg-green-50" :
    critiqueScore >= 4.0 ? "text-blue-600 bg-blue-50" :
    critiqueScore >= 3.0 ? "text-yellow-700 bg-yellow-50" :
    "text-red-700 bg-red-50";
  return (
    <div className="border rounded-lg p-4 bg-white">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">Critic score</h3>
      <div className={`inline-flex items-center px-3 py-1 rounded-full text-2xl font-mono ${color}`}>
        {critiqueScore.toFixed(1)} / 5
      </div>
      <p className="text-xs text-gray-500 mt-2">
        Weighted rubric: 2× faithfulness + completeness + citation quality + clarity.
      </p>
    </div>
  );
}

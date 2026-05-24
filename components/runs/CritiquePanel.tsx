"use client";

export type CritiquePanelProps = {
  critiqueScore: number | null;
};

export function CritiquePanel({ critiqueScore }: CritiquePanelProps) {
  if (critiqueScore == null) return null;
  // Three-tier scale on Thoth's palette — blue ink for strong, gold for
  // mid, warn for low. Avoids the Tailwind red/green default that clashes
  // with the warm papyrus background (see docs/brand.md).
  const color =
    critiqueScore >= 4.0
      ? "text-[var(--thoth-blue-ink)] bg-[var(--thoth-blue-mist)]"
      : critiqueScore >= 3.0
        ? "text-[var(--thoth-blue-ink)] bg-[color-mix(in_oklab,var(--thoth-gold)_22%,var(--thoth-papyrus))]"
        : "text-[var(--thoth-warn)] bg-[color-mix(in_oklab,var(--thoth-warn)_8%,var(--thoth-papyrus))]";
  return (
    <div className="border border-[var(--thoth-rule)] rounded-lg p-4 bg-[var(--thoth-papyrus)]">
      <h3 className="eyebrow text-[var(--thoth-stone)] mb-2">Critic score</h3>
      <div className={`inline-flex items-center px-3 py-1 rounded-full text-2xl font-mono ${color}`}>
        {critiqueScore.toFixed(1)} / 5
      </div>
      <p className="text-xs text-[var(--thoth-stone)] mt-2">
        Weighted rubric: 2× faithfulness + completeness + citation quality + clarity.
      </p>
    </div>
  );
}

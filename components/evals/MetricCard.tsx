export type MetricCardProps = {
  label: string;
  value: number; // 0-1
};

/**
 * Editorial metric tile: large serif numeral in Fraunces, eyebrow label,
 * subtle quality bar at the bottom. The bar's hue tracks the score
 * (Thoth gold for excellent, blue for solid, stone for weak) so each
 * card carries its own data without shouting in red/green primaries.
 */
export function MetricCard({ label, value }: MetricCardProps) {
  const pct = Math.round(value * 100);
  const hue =
    pct >= 75
      ? "var(--thoth-gold)"
      : pct >= 50
      ? "var(--thoth-blue)"
      : "var(--thoth-stone)";

  return (
    <div className="bg-[oklch(1_0_0)] border border-[var(--thoth-rule)] rounded-lg p-6 flex flex-col gap-4">
      <span className="eyebrow">{label}</span>

      <div className="flex items-baseline gap-1">
        <span
          className="font-display text-[var(--thoth-blue-ink)] tabular-nums leading-none"
          style={{
            fontSize: "3rem",
            fontWeight: 500,
            fontVariationSettings: "'opsz' 72",
          }}
        >
          {pct}
        </span>
        <span className="font-display text-2xl text-[var(--thoth-stone)] leading-none">
          %
        </span>
      </div>

      <div className="relative h-[3px] bg-[var(--thoth-rule)] rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: hue }}
        />
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";

export type ClaimCheckRow = {
  id: string;
  paperId: string;
  claim: string;
  verdict: "SUPPORTED" | "UNSUPPORTED" | "UNCLEAR";
  reason: string;
  paperExcerpt: string | null;
};

export type CitationFaithfulnessWidgetProps = {
  faithfulnessScore: number | null;
  claimChecks: ClaimCheckRow[];
};

// Verdict colours map to the Thoth palette (see docs/brand.md) instead
// of Tailwind's default red/green which clash with the papyrus
// background. SUPPORTED reads as the trust accent (blue ink);
// UNSUPPORTED uses the warn brick; UNCLEAR sits on neutral stone.
const VERDICT_COLOR: Record<ClaimCheckRow["verdict"], string> = {
  SUPPORTED: "var(--thoth-blue-ink)",
  UNSUPPORTED: "var(--thoth-warn)",
  UNCLEAR: "var(--thoth-stone)",
};

export function CitationFaithfulnessWidget({
  faithfulnessScore,
  claimChecks,
}: CitationFaithfulnessWidgetProps) {
  const [open, setOpen] = useState(false);
  if (faithfulnessScore == null) return null;
  const pct = Math.round(faithfulnessScore * 100);
  const color =
    pct >= 80
      ? "text-[var(--thoth-blue-ink)] bg-[var(--thoth-blue-mist)]"
      : pct >= 50
        ? "text-[var(--thoth-blue-ink)] bg-[color-mix(in_oklab,var(--thoth-gold)_22%,var(--thoth-papyrus))]"
        : "text-[var(--thoth-warn)] bg-[color-mix(in_oklab,var(--thoth-warn)_8%,var(--thoth-papyrus))]";
  const supported = claimChecks.filter((c) => c.verdict === "SUPPORTED").length;
  return (
    <div className="border border-[var(--thoth-rule)] rounded-lg p-4 bg-[var(--thoth-papyrus)]">
      <h3 className="eyebrow text-[var(--thoth-stone)] mb-2">Citation faithfulness</h3>
      <div className={`inline-flex items-center px-3 py-1 rounded-full text-2xl font-mono ${color}`}>
        {pct}%
      </div>
      <p className="text-xs text-[var(--thoth-stone)] mt-2">
        {supported} of {claimChecks.length} citations supported.
      </p>
      {claimChecks.length > 0 && (
        <button
          type="button"
          className="text-xs text-[var(--thoth-blue)] hover:underline mt-1"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "Show"} per-citation verdicts
        </button>
      )}
      {open && (
        <div className="mt-3 space-y-2 max-h-96 overflow-y-auto">
          {claimChecks.map((c) => (
            <div
              key={c.id}
              className="text-xs border-l-2 pl-2"
              style={{ borderColor: VERDICT_COLOR[c.verdict] ?? "var(--thoth-stone)" }}
            >
              <div className="font-mono text-[var(--thoth-stone)]">[{c.paperId}] — {c.verdict.toLowerCase()}</div>
              <div className="text-[var(--thoth-blue-ink)] italic">&quot;{c.claim}&quot;</div>
              <div className="text-[var(--thoth-stone)]">{c.reason}</div>
              {c.paperExcerpt && (
                <div className="text-[var(--thoth-stone)] mt-1">Excerpt: {c.paperExcerpt}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

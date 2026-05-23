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

const VERDICT_COLOR: Record<ClaimCheckRow["verdict"], string> = {
  SUPPORTED: "#16a34a",
  UNSUPPORTED: "#dc2626",
  UNCLEAR: "#a16207",
};

export function CitationFaithfulnessWidget({
  faithfulnessScore,
  claimChecks,
}: CitationFaithfulnessWidgetProps) {
  const [open, setOpen] = useState(false);
  if (faithfulnessScore == null) return null;
  const pct = Math.round(faithfulnessScore * 100);
  const color =
    pct >= 80 ? "text-green-600 bg-green-50" :
    pct >= 50 ? "text-yellow-700 bg-yellow-50" :
    "text-red-700 bg-red-50";
  const supported = claimChecks.filter((c) => c.verdict === "SUPPORTED").length;
  return (
    <div className="border rounded-lg p-4 bg-white">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">Citation faithfulness</h3>
      <div className={`inline-flex items-center px-3 py-1 rounded-full text-2xl font-mono ${color}`}>
        {pct}%
      </div>
      <p className="text-xs text-gray-500 mt-2">
        {supported} of {claimChecks.length} citations supported.
      </p>
      {claimChecks.length > 0 && (
        <button
          type="button"
          className="text-xs text-blue-600 hover:underline mt-1"
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
              style={{ borderColor: VERDICT_COLOR[c.verdict] ?? "#9ca3af" }}
            >
              <div className="font-mono text-gray-500">[{c.paperId}] — {c.verdict.toLowerCase()}</div>
              <div className="text-gray-800 italic">&quot;{c.claim}&quot;</div>
              <div className="text-gray-600">{c.reason}</div>
              {c.paperExcerpt && (
                <div className="text-gray-500 mt-1">Excerpt: {c.paperExcerpt}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

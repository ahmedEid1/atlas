import type { ModelMessage } from "ai";
import { z } from "zod";
import type { Plan } from "@/lib/prompts/plan-review";

/**
 * V2 screener output — per-paper inclusion verdict against the plan's
 * inclusion / exclusion criteria.
 */
export const ScreeningVerdictSchema = z.object({
  include: z.boolean(),
  relevanceScore: z.number().min(0).max(1),
  reason: z
    .string()
    .min(20, "reason must be at least 20 characters")
    .max(800, "reason must be at most 800 characters"),
});

export type ScreeningVerdict = z.infer<typeof ScreeningVerdictSchema>;

const SYSTEM = `You are a screening reviewer for a systematic literature review. You score one candidate paper against the user's research question + PICOC + inclusion criteria + exclusion criteria and decide whether it should be included for full assessment.

Return a single JSON object:
- include: true if the paper passes ALL inclusion criteria AND no exclusion criteria, else false
- relevanceScore: 0-1, how well the paper addresses the user's question (independent of inclusion decision — a marginally-relevant paper that passes criteria might still score 0.5)
- reason: one or two sentences explaining the score AND the inclusion decision. Mention specifically which criterion the paper passes or fails.

Be strict on inclusion. Outbound search will surface many tangentially-relevant papers; the screener's job is to keep the corpus focused. A paper that's about an adjacent topic but doesn't directly address the question should be excluded with relevanceScore 0.3-0.5.

You will see the paper title + abstract + (when available) the OCR'd full text. If only an abstract is available, you can still produce a confident verdict — abstracts are usually enough to assess inclusion.`;

export function buildScreenPaperRequest(args: {
  question: string;
  plan: Plan;
  paper: {
    title: string;
    abstract: string | null;
    fullText: string | null;
  };
}): { system: string; messages: ModelMessage[] } {
  const fullText = args.paper.fullText
    ? `\n\nFull text (first 8000 chars):\n${args.paper.fullText.slice(0, 8000)}`
    : "";
  return {
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Research question:\n\n> ${args.question}\n\nPlan:\n${JSON.stringify(args.plan, null, 2)}\n\nPaper title: ${args.paper.title}\n\nPaper abstract:\n${args.paper.abstract ?? "(not available — score on title + full text below)"}${fullText}\n\nDecide.`,
      },
    ],
  };
}

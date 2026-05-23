import type { ModelMessage } from "ai";
import { z } from "zod";
import type { Plan } from "@/lib/prompts/plan-review";
import type { ClaimSpec } from "@/lib/agent/state";

export const DraftSchema = z.object({
  draft: z.string().min(1),
});

export type Draft = z.infer<typeof DraftSchema>;

const SYSTEM = `You are a research writer composing a systematic literature review section from a curated set of claims.

Format:
- Markdown
- Use H2 (##) section headings keyed to the plan's sub-questions, plus an Introduction and a Discussion
- Cite each claim with [paper_id] inline, where paper_id is the corpus item id provided
- A claim must be cited where it appears. Multiple citations: [c1] [c4] (space-separated)
- If a finding is contested across papers, present both views with citations to each
- Do NOT cite a paper id you were not given. Do NOT invent claims that aren't in the input list.
- Length: 600-1500 words.`;

export function buildDrafterRequest(args: {
  question: string;
  plan: Plan;
  claims: ClaimSpec[];
  critiqueFeedback?: string;
}): {
  system: string;
  messages: ModelMessage[];
} {
  const claimsLines = args.claims
    .map((c) => `- [${c.includedPaperId}] (${c.category}) ${c.text}`)
    .join("\n");

  const reviseBlock = args.critiqueFeedback
    ? `\n\nRevise based on this feedback from the critic:\n\n${args.critiqueFeedback}\n`
    : "";

  return {
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Research question:\n\n> ${args.question}\n\nPlan:\n${JSON.stringify(args.plan, null, 2)}\n\nClaims (each prefixed with its source paper id):\n${claimsLines}${reviseBlock}\n\nWrite the review.`,
      },
    ],
  };
}

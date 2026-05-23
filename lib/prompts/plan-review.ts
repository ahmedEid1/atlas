import type { ModelMessage } from "ai";
import { z } from "zod";

export const PlanSchema = z.object({
  picoc: z.object({
    population: z.string(),
    intervention: z.string(),
    comparison: z.string(),
    outcome: z.string(),
    context: z.string(),
  }),
  subQuestions: z.array(z.string()),
  inclusionCriteria: z.array(z.string()),
  exclusionCriteria: z.array(z.string()),
});

export type Plan = z.infer<typeof PlanSchema>;

const SYSTEM = `You are a research methodologist planning a systematic literature review.

You will receive the user's research question and the number of candidate papers already in their corpus.

Produce a structured plan with:
- A PICOC decomposition (Population, Intervention, Comparison, Outcome, Context)
- 2-5 sub-questions that, when answered together, answer the user's main question
- 3-6 inclusion criteria a paper must meet to be considered
- 2-4 exclusion criteria that disqualify a paper

The plan will be reviewed by the user before any retrieval happens. Be specific and actionable. Avoid generic criteria like "high quality" — anchor to the domain.`;

export function buildPlannerRequest(args: { question: string; corpusSize: number }): {
  system: string;
  messages: ModelMessage[];
} {
  return {
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Research question:\n\n> ${args.question}\n\nCorpus size already uploaded: ${args.corpusSize} paper(s).\n\nProduce the structured plan.`,
      },
    ],
  };
}

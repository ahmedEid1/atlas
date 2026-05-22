import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Plan } from "@/lib/prompts/plan-review";
import type { CandidateCorpusItem } from "@/lib/agent/state";

export const PaperScoreSchema = z.object({
  relevanceScore: z.number().min(0).max(1),
  include: z.boolean(),
  reason: z.string(),
});

export type PaperScore = z.infer<typeof PaperScoreSchema>;

const SYSTEM = `You are a research analyst scoring a paper for inclusion in a systematic literature review.

You will receive the user's research question, a structured plan (PICOC, sub-questions, inclusion/exclusion criteria), and a paper summary.

Return a single JSON object:
- relevanceScore: 0-1, how well the paper addresses the user's question and PICOC
- include: true if the paper passes ALL inclusion criteria AND no exclusion criteria, else false
- reason: one sentence explaining the score AND the inclusion decision

Be honest. If the paper is tangential, score it low and exclude it — don't pad the corpus to please the user.`;

export function buildPaperScoreRequest(args: {
  question: string;
  plan: Plan;
  paper: CandidateCorpusItem;
}): {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
} {
  return {
    system: [{ type: "text", text: SYSTEM }],
    messages: [
      {
        role: "user",
        content: `User question: ${args.question}

Plan:
${JSON.stringify(args.plan, null, 2)}

Paper id: ${args.paper.id}
Paper title: ${args.paper.title}
Paper summary:
${JSON.stringify(args.paper.summary, null, 2)}

Score this paper.`,
      },
    ],
  };
}

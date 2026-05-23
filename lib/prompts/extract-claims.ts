import type { ModelMessage } from "ai";
import { z } from "zod";

export const ClaimsSchema = z.object({
  claims: z.array(
    z.object({
      text: z.string(),
      category: z.enum(["finding", "methodology", "limitation", "context"]),
    }),
  ),
});

export type Claims = z.infer<typeof ClaimsSchema>;

const SYSTEM_INSTRUCTIONS = `You are a research analyst extracting structured claims from a paper for a systematic literature review.

Read the paper provided below and return a list of claims, each tagged with one category:
- "finding" — a result or conclusion the paper supports (preferably with numbers)
- "methodology" — a key design decision (sample, instrument, analysis approach)
- "limitation" — a constraint on validity or generalisability
- "context" — domain or setting facts useful for synthesis

Aim for 5-15 claims per paper. Be specific. Quote numbers and effect sizes when the paper does. Do NOT include claims the paper does not support.`;

export function buildExtractClaimsRequest(args: {
  question: string;
  paperMarkdown: string;
}): {
  system: string;
  messages: ModelMessage[];
} {
  return {
    system: `${SYSTEM_INSTRUCTIONS}\n\n<paper>\n${args.paperMarkdown}\n</paper>`,
    messages: [
      {
        role: "user",
        content: `The user's research question is:\n\n> ${args.question}\n\nExtract claims from the paper above that are relevant to this question.`,
      },
    ],
  };
}

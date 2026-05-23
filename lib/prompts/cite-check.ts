import type { ModelMessage } from "ai";
import { z } from "zod";

export const CiteCheckPerCitationSchema = z.object({
  verdict: z.enum(["supported", "unsupported", "unclear"]),
  reason: z.string().min(10).max(1500).describe("Specific evidence from the paper or specific gap (1-3 sentences)"),
  paperExcerpt: z
    .string()
    .max(300)
    .optional()
    .describe("Short quote (<= 1 sentence) from the paper that directly supports or contradicts the claim, when one exists"),
});

export type CiteCheckPerCitation = z.infer<typeof CiteCheckPerCitationSchema>;

const SYSTEM = `You verify whether a single claim in a literature review draft is supported by the paper it cites.

You will see:
- The claim (a sentence from the draft, including its [paper_id] citation marker)
- The paper's summary

Decide:
- verdict = "supported" when the paper's summary clearly contains evidence for the claim
- verdict = "unsupported" when the paper's summary clearly contradicts the claim, OR when the claim makes a generalization the paper doesn't justify (e.g., paper is about acute pain, claim is about chronic)
- verdict = "unclear" when the summary is too brief or ambiguous to decide either way

Always write a 1-2 sentence reason citing specific evidence (or its absence). When the paper contains a direct quote supporting/contradicting the claim, include it as paperExcerpt.`;

export function buildCiteCheckRequest(args: {
  claim: string;
  paperId: string;
  paperSummary: string;
}): {
  system: string;
  messages: ModelMessage[];
} {
  const userContent = `Claim from the draft:
"${args.claim}"

The cited paper id is [${args.paperId}]. Here is its summary:

${args.paperSummary}

Verify: does this paper support the claim? Output structured JSON matching the schema.`;

  return {
    system: SYSTEM,
    messages: [{ role: "user", content: userContent }],
  };
}

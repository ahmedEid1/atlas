import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const PaperSummarySchema = z.object({
  /** One-paragraph plain-English abstract written by the agent (not copied from the paper). */
  abstract: z.string(),
  /** The research questions the paper itself addresses. */
  researchQuestions: z.array(z.string()),
  /** One-paragraph methodology summary. */
  methodology: z.string(),
  /** Bullet list of headline findings, each as a complete sentence. */
  keyFindings: z.array(z.string()),
  /** Bullet list of limitations the authors or the reader should be aware of. */
  limitations: z.array(z.string()),
  /** Study type — used downstream for the Kitchenham quality instrument selection. */
  studyType: z.enum([
    "empirical",
    "experiment",
    "case_study",
    "survey",
    "review",
    "theoretical",
    "other",
  ]),
  /** Heuristic judgement of fit to the user's research question — refined by the M3 assessor. */
  relevanceToSLR: z.enum(["highly_relevant", "relevant", "tangential", "off_topic"]),
});

export type PaperSummary = z.infer<typeof PaperSummarySchema>;

const SYSTEM_INSTRUCTIONS = `You are a research analyst preparing a structured paper summary for a systematic literature review.

Your job is to read the paper provided in the next system block and produce a JSON summary matching the schema.

Rules:
- Write in your own words. Do NOT copy abstract text verbatim.
- "researchQuestions" lists what the PAPER asks, not the user's research question.
- "keyFindings" must be complete sentences a reader can act on. Quantify when the paper does ("X improves Y by 25%", not "X improves Y").
- "limitations" includes both authors' acknowledged limitations and your reader's-eye observations.
- "studyType" is your best classification. When in doubt, prefer "empirical" over "other".
- "relevanceToSLR" is a heuristic — be honest. If the paper barely touches the user's research question, say "tangential" or "off_topic".`;

export function buildSummarizePaperRequest(args: {
  paperMarkdown: string;
  researchQuestion: string;
}): {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
} {
  return {
    system: [
      {
        type: "text",
        text: SYSTEM_INSTRUCTIONS,
      },
      {
        type: "text",
        text: `<paper>\n${args.paperMarkdown}\n</paper>`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `The user's research question for the SLR is:\n\n> ${args.researchQuestion}\n\nProduce the structured summary.`,
      },
    ],
  };
}

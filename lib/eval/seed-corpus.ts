import { db } from "@/lib/db";
import type { GoldenQuestion } from "@/lib/eval/golden-schema";

export type SeedResult = {
  userId: string;
  projectId: string;
  corpusItemIds: string[];
  /** Maps the YAML's paper.id to Atlas's corpus item id (cuid) — eval metrics need this. */
  paperIdMap: Record<string, string>;
};

const EVAL_CLERK_ID = "user_eval_runner_synthetic";
const EVAL_EMAIL = "evals@atlas.local";

/**
 * Provisions a fresh user/project/corpus from a golden question. CorpusItems
 * are inserted directly as PARSED (skipping marker-pdf) with the inline
 * markdown + summary the YAML provides. This keeps evals fast and free.
 *
 * Before creating the new project, deletes any prior project with the same
 * title (cascades to corpus, runs, claims, claim checks). This keeps Neon's
 * 0.5 GB free tier from accumulating eval data across nightly runs — only
 * ONE project per golden question lives at a time. Trend history is preserved
 * in the EvalRun table (untouched by the cascade).
 */
export async function seedEvalProject(golden: GoldenQuestion): Promise<SeedResult> {
  const user = await db.user.upsert({
    where: { clerkId: EVAL_CLERK_ID },
    create: { clerkId: EVAL_CLERK_ID, email: EVAL_EMAIL },
    update: {},
  });

  // Clean up previous eval project for this question (cascades to all children)
  await db.project.deleteMany({
    where: { ownerId: user.id, title: `eval-${golden.id}` },
  });

  const project = await db.project.create({
    data: {
      ownerId: user.id,
      title: `eval-${golden.id}`,
      question: golden.question,
    },
  });

  const paperIdMap: Record<string, string> = {};
  const corpusItemIds: string[] = [];
  for (const paper of golden.papers) {
    const item = await db.corpusItem.create({
      data: {
        projectId: project.id,
        kind: "NOTE", // bypassing PDF parse
        status: "PARSED",
        source: `golden:${paper.id}`,
        parsedMarkdown: paper.markdown,
        summary: {
          abstract: paper.summary,
          researchQuestions: [],
          methodology: "",
          keyFindings: [],
          limitations: [],
          studyType: "other",
          relevanceToSLR: "relevant",
        },
        summarisedAt: new Date(),
      },
    });
    paperIdMap[paper.id] = item.id;
    corpusItemIds.push(item.id);
  }

  return { userId: user.id, projectId: project.id, corpusItemIds, paperIdMap };
}

import { tasks, wait } from "@trigger.dev/sdk";
import type { parsePdfTask } from "@/trigger/parse-pdf";
import type { summarizePaperTask } from "@/trigger/summarize-paper";
import type { runReviewTask } from "@/trigger/run-review";

export async function enqueueParsePdf(corpusItemId: string): Promise<void> {
  await tasks.trigger<typeof parsePdfTask>("parse-pdf", { corpusItemId });
}

export async function enqueueSummarizePaper(corpusItemId: string): Promise<{ id: string }> {
  const handle = await tasks.trigger<typeof summarizePaperTask>("summarize-paper", {
    corpusItemId,
  });
  return { id: handle.id };
}

export async function enqueueRunReview(runId: string): Promise<{ id: string }> {
  const handle = await tasks.trigger<typeof runReviewTask>("run-review", { runId });
  return { id: handle.id };
}

export async function resolveWaitToken(token: string, payload: unknown): Promise<void> {
  await wait.completeToken(token, payload);
}

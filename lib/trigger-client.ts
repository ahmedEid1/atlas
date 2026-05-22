import { tasks } from "@trigger.dev/sdk";
import type { parsePdfTask } from "@/trigger/parse-pdf";
import type { summarizePaperTask } from "@/trigger/summarize-paper";

export async function enqueueParsePdf(corpusItemId: string): Promise<void> {
  await tasks.trigger<typeof parsePdfTask>("parse-pdf", { corpusItemId });
}

export async function enqueueSummarizePaper(corpusItemId: string): Promise<{ id: string }> {
  const handle = await tasks.trigger<typeof summarizePaperTask>("summarize-paper", {
    corpusItemId,
  });
  return { id: handle.id };
}

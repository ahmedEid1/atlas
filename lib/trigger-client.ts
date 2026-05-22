import { tasks } from "@trigger.dev/sdk";
import type { parsePdfTask } from "@/trigger/parse-pdf";

export async function enqueueParsePdf(corpusItemId: string): Promise<void> {
  await tasks.trigger<typeof parsePdfTask>("parse-pdf", { corpusItemId });
}

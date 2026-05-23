import { schemaTask, logger, metadata } from "@trigger.dev/sdk";
import { z } from "zod";
import { db } from "@/lib/db";
import { runLLM } from "@/lib/llm";
import {
  PaperSummarySchema,
  buildSummarizePaperRequest,
} from "@/lib/prompts/summarize-paper";

export const summarizePaperTask = schemaTask({
  id: "summarize-paper",
  schema: z.object({ corpusItemId: z.string() }),
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30_000 },
  machine: { preset: "small-2x" },
  maxDuration: 300,
  run: async ({ corpusItemId }) => {
    const item = await db.corpusItem.findUnique({
      where: { id: corpusItemId },
      include: { project: { select: { question: true } } },
    });
    if (!item) throw new Error(`CorpusItem ${corpusItemId} not found`);
    if (item.status !== "PARSED" || !item.parsedMarkdown) {
      throw new Error(`CorpusItem ${corpusItemId} is not yet PARSED (status: ${item.status})`);
    }

    metadata.set("status", "summarising");

    try {
      const { system, messages } = buildSummarizePaperRequest({
        paperMarkdown: item.parsedMarkdown,
        researchQuestion: item.project.question,
      });

      const { output, traceUrl, usage } = await runLLM({
        name: "summarize-paper",
        tier: "fast",
        maxTokens: 4096,
        system,
        messages,
        schema: PaperSummarySchema,
        metadata: { corpusItemId, projectId: item.projectId },
      });

      await db.corpusItem.update({
        where: { id: corpusItemId },
        data: {
          summary: output,
          summaryTraceUrl: traceUrl,
          summarisedAt: new Date(),
          failureReason: null,
        },
      });

      metadata
        .set("status", "summarised")
        .set("inputTokens", usage.inputTokens)
        .set("outputTokens", usage.outputTokens)
        .set("cacheReadInputTokens", usage.cacheReadInputTokens);

      logger.info("summarize-paper done", {
        corpusItemId,
        usage,
        traceUrl,
      });

      return { ok: true, traceUrl, usage };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await db.corpusItem.update({
        where: { id: corpusItemId },
        data: { failureReason: reason.slice(0, 1000) },
      });
      throw err;
    }
  },
});

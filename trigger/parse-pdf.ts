import { schemaTask, logger, metadata } from "@trigger.dev/sdk";
import { z } from "zod";
import { db } from "@/lib/db";
import { getObjectBytes } from "@/lib/object-store";
import { parsePdfWithMistral } from "@/lib/pdf-parse";

export const parsePdfTask = schemaTask({
  id: "parse-pdf",
  schema: z.object({ corpusItemId: z.string() }),
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30000 },
  machine: { preset: "small-2x" }, // Mistral OCR is fast; small machine is plenty
  maxDuration: 120, // OCR takes ~5-15 sec; 2 min is generous
  run: async ({ corpusItemId }) => {
    const item = await db.corpusItem.findUnique({ where: { id: corpusItemId } });
    if (!item) throw new Error(`CorpusItem ${corpusItemId} not found`);
    if (item.kind !== "PDF") throw new Error(`Expected PDF, got ${item.kind}`);

    await db.corpusItem.update({
      where: { id: corpusItemId },
      data: { status: "PARSING", failureReason: null },
    });
    metadata.set("status", "parsing");

    try {
      logger.info("Downloading PDF from object store", { source: item.source });
      const pdfBytes = await getObjectBytes(item.source);

      logger.info("Calling Mistral OCR", { byteSize: pdfBytes.length });
      const { markdown, pageCount, charCount } = await parsePdfWithMistral(pdfBytes);

      await db.corpusItem.update({
        where: { id: corpusItemId },
        data: { status: "PARSED", parsedMarkdown: markdown },
      });
      metadata.set("status", "parsed").set("pageCount", pageCount).set("charCount", charCount);

      logger.info("PDF parsed successfully", { pageCount, charCount });
      return { ok: true, pageCount, charCount };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error("PDF parse failed", { reason });
      await db.corpusItem.update({
        where: { id: corpusItemId },
        data: { status: "FAILED", failureReason: reason.slice(0, 1000) },
      });
      throw err;
    }
  },
});

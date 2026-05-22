import { schemaTask, logger, metadata } from "@trigger.dev/sdk";
import { python } from "@trigger.dev/python";
import { z } from "zod";
import { db } from "@/lib/db";

export const parsePdfTask = schemaTask({
  id: "parse-pdf",
  schema: z.object({ corpusItemId: z.string() }),
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30000 },
  machine: { preset: "large-1x" },
  maxDuration: 600,
  run: async ({ corpusItemId }) => {
    const item = await db.corpusItem.findUnique({ where: { id: corpusItemId } });
    if (!item) throw new Error(`CorpusItem ${corpusItemId} not found`);
    if (item.kind !== "PDF") throw new Error(`Expected PDF, got ${item.kind}`);

    await db.corpusItem.update({
      where: { id: corpusItemId },
      data: { status: "PARSING", failureReason: null },
    });
    metadata.set("status", "parsing");

    const outKey = `${item.source.replace(/\.pdf$/, "")}.md`;
    const bucket = process.env.S3_BUCKET ?? "";

    try {
      const result = await python.runScript("./python/parse_pdf.py", [bucket, item.source, outKey]);

      if (result.exitCode !== 0) {
        logger.error("python parser failed", { stderr: result.stderr });
        throw new Error(`python parser exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`);
      }

      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        out_key: string;
        page_count: number;
        char_count: number;
      };

      const { getObjectBytes } = await import("@/lib/object-store");
      const md = new TextDecoder().decode(await getObjectBytes(parsed.out_key));

      await db.corpusItem.update({
        where: { id: corpusItemId },
        data: { status: "PARSED", parsedMarkdown: md },
      });
      metadata.set("status", "parsed").set("pageCount", parsed.page_count);

      return { ok: true, pageCount: parsed.page_count, charCount: parsed.char_count };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await db.corpusItem.update({
        where: { id: corpusItemId },
        data: { status: "FAILED", failureReason: reason.slice(0, 1000) },
      });
      throw err;
    }
  },
});

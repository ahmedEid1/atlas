import { Mistral } from "@mistralai/mistralai";
import { env } from "@/lib/env";

export type PdfParseResult = {
  markdown: string;
  pageCount: number;
  charCount: number;
};

let _client: Mistral | null = null;

function getMistralClient(): Mistral {
  if (_client) return _client;
  if (!env.MISTRAL_API_KEY) {
    throw new Error(
      "MISTRAL_API_KEY is not set. Add it to .env (and Trigger.dev project env via the next deploy).",
    );
  }
  _client = new Mistral({ apiKey: env.MISTRAL_API_KEY });
  return _client;
}

/**
 * Parse a PDF using Mistral OCR. Concatenates per-page markdown with
 * page-break headers between them so the structure stays clear in the
 * agent's view.
 *
 * Sends the PDF as base64 data URL (no public hosting needed; works for
 * R2-stored private PDFs). Mistral's limit is 50 MB / 1000 pages per request.
 */
export async function parsePdfWithMistral(pdfBytes: Uint8Array): Promise<PdfParseResult> {
  const base64Pdf = Buffer.from(pdfBytes).toString("base64");

  const client = getMistralClient();
  const ocrResponse = await client.ocr.process({
    model: "mistral-ocr-latest",
    document: {
      type: "document_url",
      documentUrl: `data:application/pdf;base64,${base64Pdf}`,
    },
    includeImageBase64: false,
  });

  const pages = ocrResponse.pages ?? [];
  if (pages.length === 0) {
    throw new Error("Mistral OCR returned no pages");
  }

  // Concatenate per-page markdown with thin page-break headers
  const markdown = pages
    .map((p, i) => `## Page ${i + 1}\n\n${p.markdown ?? ""}`)
    .join("\n\n---\n\n");

  return {
    markdown,
    pageCount: pages.length,
    charCount: markdown.length,
  };
}

import { Mistral } from "@mistralai/mistralai";
import { env } from "@/lib/env";

export type PdfParseResult = {
  markdown: string;
  pageCount: number;
  charCount: number;
};

export type ParsePdfOptions = {
  /**
   * Backoff between OCR retries, in ms. Defaults to a short fixed delay in
   * prod; pass `0` (or a tiny value) in tests so the bounded-retry loop runs
   * instantly without real timers.
   */
  delayMs?: number;
};

// Bounded retry on TRANSIENT OCR failures only — mirrors lib/llm.ts's
// same-provider bounded retry. 1 initial attempt + 2 retries = 3 total.
// Without this, a single transient 429/5xx/network blip on Mistral's free
// tier throws, the fetcher catches it, and the paper is SILENTLY dropped from
// the corpus (corpusItemId stays null) — biasing the corpus toward whichever
// papers happened to win the rate-limit lottery.
const OCR_RETRY_ATTEMPTS = 2; // 1 initial attempt + 2 retries = 3 total
const OCR_RETRY_DELAY_MS = 1_000;

let _client: Mistral | null = null;

/**
 * Read a numeric HTTP status off a thrown error, if present. The Mistral SDK's
 * `MistralError` / `SDKError` / `ResponseValidationError` all carry the HTTP
 * status as a `statusCode` property; some transports/fetch layers use `status`.
 */
function errorStatusCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === "number") return e.statusCode;
  if (typeof e.status === "number") return e.status;
  return undefined;
}

/**
 * Classify an OCR error as transient (worth retrying) vs permanent (fail fast).
 *
 * Transient — retry:
 *   - HTTP 429 (rate limited) or any HTTP >= 500 (server-side).
 *   - Network / connection errors: the SDK's HTTPClientError subclasses are
 *     identified by their stable `name` (ConnectionError / RequestTimeoutError
 *     / RequestAbortedError / UnexpectedClientError); raw fetch/undici failures
 *     surface as TypeError "fetch failed" or carry a `code` like ECONNRESET.
 *
 * Permanent — fail fast:
 *   - HTTP 400-428 / 431 (bad request / validation / unprocessable / unparseable PDF).
 *   - ResponseValidationError and everything else not matched above.
 *
 * Detection note (verified against @mistralai/mistralai's error model):
 * `MistralError.statusCode` is the authoritative status signal. When no numeric
 * status is present we fall back to network-error name/shape detection, and treat
 * everything else as permanent.
 */
function isTransientOcrError(err: unknown): boolean {
  const status = errorStatusCode(err);
  if (status !== undefined) {
    return status === 429 || status >= 500;
  }

  if (typeof err === "object" && err !== null) {
    const e = err as { name?: unknown; code?: unknown; cause?: unknown };
    const name = typeof e.name === "string" ? e.name : "";
    if (
      name === "ConnectionError" ||
      name === "RequestTimeoutError" ||
      name === "RequestAbortedError" ||
      name === "UnexpectedClientError" ||
      name === "TimeoutError" ||
      name === "AbortError"
    ) {
      return true;
    }
    // undici/Node fetch network failures: TypeError "fetch failed" (often with a
    // cause), or an errno-style `code`.
    if (typeof e.code === "string" && /^(ECONN|ETIMEDOUT|ENETWORK|EAI_AGAIN|EPIPE|ENOTFOUND)/.test(e.code)) {
      return true;
    }
    if (err instanceof TypeError && /fetch failed|network/i.test((err as Error).message)) {
      return true;
    }
  }
  return false;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
export async function parsePdfWithMistral(
  pdfBytes: Uint8Array,
  options: ParsePdfOptions = {},
): Promise<PdfParseResult> {
  const base64Pdf = Buffer.from(pdfBytes).toString("base64");
  const delayMs = options.delayMs ?? OCR_RETRY_DELAY_MS;

  const client = getMistralClient();

  // Bounded retry on TRANSIENT errors only. A permanent / unparseable failure
  // is rethrown immediately (no retry). After retries are exhausted on a
  // transient error we rethrow with a message that DISTINGUISHES the two cases
  // so the fetcher's recorded failureReason makes the corpus-bias case
  // auditable ("transient OCR failure (retries exhausted)" vs
  // "permanent OCR failure").
  const runOcr = () =>
    client.ocr.process({
      model: "mistral-ocr-latest",
      document: {
        type: "document_url",
        documentUrl: `data:application/pdf;base64,${base64Pdf}`,
      },
      includeImageBase64: false,
    });

  let ocrResponse: Awaited<ReturnType<typeof runOcr>>;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= OCR_RETRY_ATTEMPTS; attempt++) {
    try {
      ocrResponse = await runOcr();
      break;
    } catch (err) {
      lastErr = err;
      if (!isTransientOcrError(err)) {
        // Permanent / unparseable — fail fast, no retry.
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`permanent OCR failure: ${detail}`, { cause: err });
      }
      if (attempt < OCR_RETRY_ATTEMPTS) {
        if (delayMs > 0) await sleep(delayMs * (attempt + 1));
        continue;
      }
      // Transient, but retries are exhausted.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `transient OCR failure (retries exhausted) after ${OCR_RETRY_ATTEMPTS + 1} attempts: ${detail}`,
        { cause: err },
      );
    }
  }
  // Unreachable: the loop either assigns ocrResponse and breaks, or throws.
  // The non-null assertion documents that invariant to the type checker.
  void lastErr;

  const pages = ocrResponse!.pages ?? [];
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

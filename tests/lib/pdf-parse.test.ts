import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  ocrProcess: vi.fn(),
}));

vi.mock("@mistralai/mistralai", () => ({
  Mistral: class {
    ocr = { process: mocks.ocrProcess };
  },
}));

vi.mock("@/lib/env", () => ({
  env: { MISTRAL_API_KEY: "test-key" },
}));

beforeEach(() => {
  mocks.ocrProcess.mockReset();
});

describe("parsePdfWithMistral", () => {
  it("concatenates per-page markdown with page-break headers", async () => {
    mocks.ocrProcess.mockResolvedValue({
      pages: [
        { index: 0, markdown: "# Title\n\nPage 1 content" },
        { index: 1, markdown: "Page 2 content" },
      ],
    });

    const { parsePdfWithMistral } = await import("@/lib/pdf-parse");
    const out = await parsePdfWithMistral(new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    expect(out.pageCount).toBe(2);
    expect(out.markdown).toContain("## Page 1");
    expect(out.markdown).toContain("# Title");
    expect(out.markdown).toContain("## Page 2");
    expect(out.markdown).toContain("---"); // page break
    expect(out.charCount).toBe(out.markdown.length);
  });

  it("calls Mistral with the PDF as a base64 data URL", async () => {
    mocks.ocrProcess.mockResolvedValue({ pages: [{ markdown: "x" }] });
    const { parsePdfWithMistral } = await import("@/lib/pdf-parse");
    await parsePdfWithMistral(new Uint8Array([0x25, 0x50]));

    expect(mocks.ocrProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "mistral-ocr-latest",
        document: expect.objectContaining({
          type: "document_url",
          documentUrl: expect.stringMatching(/^data:application\/pdf;base64,/),
        }),
        includeImageBase64: false,
      }),
    );
  });

  it("throws if Mistral returns no pages", async () => {
    mocks.ocrProcess.mockResolvedValue({ pages: [] });
    const { parsePdfWithMistral } = await import("@/lib/pdf-parse");
    await expect(
      parsePdfWithMistral(new Uint8Array([0x25, 0x50])),
    ).rejects.toThrow(/no pages/);
  });
});

// --- P3: bounded retry on transient OCR failures ---
//
// The OCR call is the single point where a transient rate-limit/5xx on
// Mistral's free tier silently drops a paper from the corpus (the fetcher
// catches the throw and leaves corpusItemId null). A bounded retry on ONLY
// transient errors keeps the corpus from being biased toward whichever
// papers won the rate-limit lottery, while still failing fast on a genuine
// permanent / unparseable error.

// A MistralError-shaped HTTP error: the SDK surfaces the HTTP status as a
// numeric `statusCode` property on MistralError / SDKError / ResponseValidationError.
function httpError(statusCode: number, message = `HTTP ${statusCode}`): Error {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

// A network/connection error: the SDK's HTTPClientError subclasses are
// identified by their stable `name` (ConnectionError / RequestTimeoutError / ...).
function networkError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe("parsePdfWithMistral bounded OCR retry", () => {
  const okResponse = {
    pages: [{ index: 0, markdown: "ok" }],
  };

  it("retries a transient 429 then returns the parsed result (OCR called twice)", async () => {
    mocks.ocrProcess
      .mockRejectedValueOnce(httpError(429, "Too Many Requests"))
      .mockResolvedValueOnce(okResponse);

    const { parsePdfWithMistral } = await import("@/lib/pdf-parse");
    const out = await parsePdfWithMistral(new Uint8Array([0x25, 0x50]), { delayMs: 0 });

    expect(out.pageCount).toBe(1);
    expect(out.markdown).toContain("## Page 1");
    expect(mocks.ocrProcess).toHaveBeenCalledTimes(2);
  });

  it("retries a transient 503 then returns the parsed result (OCR called twice)", async () => {
    mocks.ocrProcess
      .mockRejectedValueOnce(httpError(503, "Service Unavailable"))
      .mockResolvedValueOnce(okResponse);

    const { parsePdfWithMistral } = await import("@/lib/pdf-parse");
    const out = await parsePdfWithMistral(new Uint8Array([0x25, 0x50]), { delayMs: 0 });

    expect(out.pageCount).toBe(1);
    expect(mocks.ocrProcess).toHaveBeenCalledTimes(2);
  });

  it("retries a network/connection error then returns the parsed result (OCR called twice)", async () => {
    mocks.ocrProcess
      .mockRejectedValueOnce(networkError("ConnectionError", "ECONNRESET"))
      .mockResolvedValueOnce(okResponse);

    const { parsePdfWithMistral } = await import("@/lib/pdf-parse");
    const out = await parsePdfWithMistral(new Uint8Array([0x25, 0x50]), { delayMs: 0 });

    expect(out.pageCount).toBe(1);
    expect(mocks.ocrProcess).toHaveBeenCalledTimes(2);
  });

  it("gives up after the bounded number of attempts on a persistent 429 (3 total) and throws a transient-labelled error", async () => {
    mocks.ocrProcess.mockRejectedValue(httpError(429, "Too Many Requests"));

    const { parsePdfWithMistral } = await import("@/lib/pdf-parse");
    await expect(
      parsePdfWithMistral(new Uint8Array([0x25, 0x50]), { delayMs: 0 }),
    ).rejects.toThrow(/transient OCR failure \(retries exhausted\)/i);

    // 1 initial attempt + 2 retries = 3 total.
    expect(mocks.ocrProcess).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a permanent 400 — throws immediately (OCR called once) with a permanent-labelled error", async () => {
    mocks.ocrProcess.mockRejectedValue(httpError(400, "Bad Request"));

    const { parsePdfWithMistral } = await import("@/lib/pdf-parse");
    await expect(
      parsePdfWithMistral(new Uint8Array([0x25, 0x50]), { delayMs: 0 }),
    ).rejects.toThrow(/permanent OCR failure/i);

    expect(mocks.ocrProcess).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry an unparseable-PDF / validation error — throws immediately (OCR called once)", async () => {
    // ResponseValidationError surfaces as a non-transient error (no transient
    // statusCode, not a network error name) — treated as permanent.
    mocks.ocrProcess.mockRejectedValue(
      networkError("ResponseValidationError", "response did not match schema"),
    );

    const { parsePdfWithMistral } = await import("@/lib/pdf-parse");
    await expect(
      parsePdfWithMistral(new Uint8Array([0x25, 0x50]), { delayMs: 0 }),
    ).rejects.toThrow(/permanent OCR failure/i);

    expect(mocks.ocrProcess).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry an HTTP 422 unprocessable-entity (unparseable PDF) — throws immediately (OCR called once)", async () => {
    // 422 is in the 400-428 permanent band: a genuinely bad/unparseable PDF.
    mocks.ocrProcess.mockRejectedValue(httpError(422, "Unprocessable Entity"));

    const { parsePdfWithMistral } = await import("@/lib/pdf-parse");
    await expect(
      parsePdfWithMistral(new Uint8Array([0x25, 0x50]), { delayMs: 0 }),
    ).rejects.toThrow(/permanent OCR failure/i);

    expect(mocks.ocrProcess).toHaveBeenCalledTimes(1);
  });
});

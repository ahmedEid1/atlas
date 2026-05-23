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

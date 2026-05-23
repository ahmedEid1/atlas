import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  getObjectBytes: vi.fn(),
  parsePdfWithMistral: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    corpusItem: { findUnique: mocks.findUnique, update: mocks.update },
  },
}));

vi.mock("@/lib/object-store", () => ({
  getObjectBytes: mocks.getObjectBytes,
}));

vi.mock("@/lib/pdf-parse", () => ({
  parsePdfWithMistral: mocks.parsePdfWithMistral,
}));

// Trigger.dev SDK helpers used by the task — mock them to no-ops.
vi.mock("@trigger.dev/sdk", () => ({
  schemaTask: (def: { run: (...args: unknown[]) => Promise<unknown> }) => def,
  logger: { info: vi.fn(), error: vi.fn() },
  metadata: { set: () => ({ set: () => ({ set: () => undefined }) }) },
}));

beforeEach(() => {
  mocks.findUnique.mockReset();
  mocks.update.mockReset();
  mocks.getObjectBytes.mockReset();
  mocks.parsePdfWithMistral.mockReset();
  mocks.update.mockResolvedValue({});
});

describe("parsePdfTask", () => {
  it("marks PARSING, calls Mistral, saves markdown, marks PARSED", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "c1",
      kind: "PDF",
      source: "corpus/p1/abc.pdf",
    });
    mocks.getObjectBytes.mockResolvedValue(new Uint8Array([0x25, 0x50]));
    mocks.parsePdfWithMistral.mockResolvedValue({
      markdown: "# Paper title\n\nContent",
      pageCount: 9,
      charCount: 25,
    });

    const mod = await import("@/trigger/parse-pdf");
    const task = mod.parsePdfTask as unknown as { run: (p: { corpusItemId: string }) => Promise<{ ok: boolean; pageCount: number; charCount: number }> };
    const result = await task.run({ corpusItemId: "c1" });

    expect(result).toEqual({ ok: true, pageCount: 9, charCount: 25 });
    expect(mocks.parsePdfWithMistral).toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { status: "PARSING", failureReason: null },
    });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { status: "PARSED", parsedMarkdown: "# Paper title\n\nContent" },
    });
  });

  it("marks FAILED and rethrows when Mistral throws", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "c1",
      kind: "PDF",
      source: "corpus/p1/abc.pdf",
    });
    mocks.getObjectBytes.mockResolvedValue(new Uint8Array([0x25, 0x50]));
    mocks.parsePdfWithMistral.mockRejectedValue(new Error("mistral quota exceeded"));

    const mod = await import("@/trigger/parse-pdf");
    const task = mod.parsePdfTask as unknown as { run: (p: { corpusItemId: string }) => Promise<unknown> };
    await expect(task.run({ corpusItemId: "c1" })).rejects.toThrow(/mistral quota/);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          failureReason: expect.stringContaining("mistral quota"),
        }),
      }),
    );
  });

  it("throws if CorpusItem not found", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const mod = await import("@/trigger/parse-pdf");
    const task = mod.parsePdfTask as unknown as { run: (p: { corpusItemId: string }) => Promise<unknown> };
    await expect(task.run({ corpusItemId: "missing" })).rejects.toThrow(/not found/);
  });
});

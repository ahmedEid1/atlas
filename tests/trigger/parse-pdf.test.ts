import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@trigger.dev/sdk", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@trigger.dev/sdk");
  return {
    ...actual,
    schemaTask: (cfg: { run: (payload: unknown) => Promise<unknown> }) => cfg,
    metadata: {
      set: vi.fn().mockReturnThis(),
    },
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock("@trigger.dev/python", () => ({
  python: {
    runScript: vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ ok: true, out_key: "corpus/p1/c1.md", page_count: 3, char_count: 1234 }),
      stderr: "",
      exitCode: 0,
    }),
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    corpusItem: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("@/lib/object-store", () => ({
  getObjectBytes: vi.fn().mockResolvedValue(new TextEncoder().encode("# parsed markdown")),
}));

import { db } from "@/lib/db";

beforeEach(() => vi.clearAllMocks());

describe("parse-pdf task", () => {
  it("transitions PENDING → PARSING → PARSED with parsed markdown", async () => {
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue({
      id: "c1",
      projectId: "p1",
      source: "corpus/p1/c1.pdf",
      status: "PENDING",
      kind: "PDF",
    } as never);

    const mod = await import("@/trigger/parse-pdf");
    // In tests, schemaTask is mocked to return the config object, which has .run
    const task = mod.parsePdfTask as unknown as { run: (p: { corpusItemId: string }) => Promise<unknown> };
    await task.run({ corpusItemId: "c1" });

    const updateCalls = vi.mocked(db.corpusItem.update).mock.calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);

    const statuses = updateCalls.map((c) => (c[0] as { data: { status: string } }).data.status);
    expect(statuses[0]).toBe("PARSING");
    expect(statuses.at(-1)).toBe("PARSED");

    const finalCall = updateCalls.at(-1)!;
    expect((finalCall[0] as { data: { parsedMarkdown: string } }).data.parsedMarkdown).toBe("# parsed markdown");
  });

  it("marks FAILED with reason on python error", async () => {
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue({
      id: "c2",
      projectId: "p1",
      source: "corpus/p1/c2.pdf",
      status: "PENDING",
      kind: "PDF",
    } as never);

    const pyMod = await import("@trigger.dev/python");
    vi.mocked(pyMod.python.runScript).mockResolvedValue({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
    } as never);

    const mod = await import("@/trigger/parse-pdf");
    const task = mod.parsePdfTask as unknown as { run: (p: { corpusItemId: string }) => Promise<unknown> };
    await expect(task.run({ corpusItemId: "c2" })).rejects.toThrow(/python/i);

    const updateCalls = vi.mocked(db.corpusItem.update).mock.calls;
    const statuses = updateCalls.map((c) => (c[0] as { data: { status: string } }).data.status);
    expect(statuses.at(-1)).toBe("FAILED");
  });
});

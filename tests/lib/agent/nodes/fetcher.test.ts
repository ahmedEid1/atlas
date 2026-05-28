import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  addStep: vi.fn(),
  finishStep: vi.fn(),
  assertWithinBudget: vi.fn(),
  putObject: vi.fn(),
  parsePdfWithMistral: vi.fn(),
  corpusItemCreate: vi.fn(),
  discoveredPaperUpdate: vi.fn(),
}));

vi.mock("@/lib/agent/runs", () => ({
  addStep: mocks.addStep,
  finishStep: mocks.finishStep,
}));
vi.mock("@/lib/agent/cost-cap", () => ({
  assertWithinBudget: mocks.assertWithinBudget,
  BudgetExceededError: class extends Error {},
}));
vi.mock("@/lib/object-store", () => ({ putObject: mocks.putObject }));
vi.mock("@/lib/pdf-parse", () => ({ parsePdfWithMistral: mocks.parsePdfWithMistral }));
vi.mock("@/lib/db", () => ({
  db: {
    corpusItem: { create: mocks.corpusItemCreate },
    discoveredPaper: { update: mocks.discoveredPaperUpdate },
  },
}));

import { fetcherNode } from "@/lib/agent/nodes/fetcher";
import type { AgentState, DiscoveredPaperRef } from "@/lib/agent/state";

const baseState: AgentState = {
  runId: "r1", projectId: "p1", question: "?",
  candidateCorpusItems: [], plan: null, planApproved: null,
  includedPapers: [], papersApproved: null, claims: [],
  draft: null, critique: null, critiqueIterations: 0,
  searchScope: "outbound", searchProviders: ["openalex", "arxiv"],
  searchMaxHits: null,
  skipDiscoveryGate: false,
  discoveryQueries: [], discoveredPapers: [],
  discoveryApproved: null, screeningDecisions: [],
};

const openHit = (id: string, url: string): DiscoveredPaperRef => ({
  id,
  provider: "arxiv",
  externalId: `arxiv:${id}`,
  title: `Paper ${id}`,
  abstract: null,
  oaUrl: url,
  accessStatus: "open",
  corpusItemId: null,
});

const paywalledHit = (id: string): DiscoveredPaperRef => ({
  id,
  provider: "openalex",
  externalId: `openalex:${id}`,
  title: `Paywalled ${id}`,
  abstract: null,
  oaUrl: null,
  accessStatus: "paywalled",
  corpusItemId: null,
});

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset?.());
  mocks.addStep.mockResolvedValue({ id: "step_outer" });
  mocks.finishStep.mockResolvedValue(undefined);
  mocks.assertWithinBudget.mockResolvedValue({ tokensUsed: 0, limit: 250000 });
  mocks.putObject.mockResolvedValue(undefined);
  mocks.parsePdfWithMistral.mockResolvedValue({ markdown: "# Paper", pageCount: 8, charCount: 1000 });
  mocks.corpusItemCreate.mockImplementation(() =>
    Promise.resolve({ id: "ci_" + Math.random().toString(36).slice(2, 8) }),
  );
  mocks.discoveredPaperUpdate.mockResolvedValue({});
});

describe("fetcherNode", () => {
  it("returns early when no papers were discovered", async () => {
    const r = await fetcherNode({ ...baseState, discoveredPapers: [] });
    expect(r).toEqual({});
    expect(mocks.addStep).not.toHaveBeenCalled();
  });

  it("skips paywalled papers without downloading them", async () => {
    const r = await fetcherNode({
      ...baseState,
      discoveredPapers: [paywalledHit("a")],
    });
    expect(mocks.putObject).not.toHaveBeenCalled();
    expect(mocks.parsePdfWithMistral).not.toHaveBeenCalled();
    expect(r.discoveredPapers).toHaveLength(1);
    expect(r.discoveredPapers![0]!.corpusItemId).toBeNull();
  });

  // V2 keptExternalIds — when the user dropped a paper at the discovery
  // gate, the fetcher must NOT download it, the screener must NOT bill an
  // LLM call on it (downstream pruning), but the underlying DiscoveredPaper
  // DB row stays so the MCP `list_discovered_papers` tool can still report
  // "the discoverer surfaced N, you kept M, the screener admitted K."
  it("only fetches papers in discoveryApproved.keptExternalIds when provided", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init?: RequestInit) => {
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-type": "application/pdf", "content-length": String(pdfBytes.length) },
          });
        }
        return new Response(pdfBytes.buffer, { status: 200 });
      }),
    );
    mocks.corpusItemCreate.mockResolvedValueOnce({ id: "ci_kept" });

    const a = openHit("2401.kept", "https://arxiv.org/pdf/2401.kept");
    const b = openHit("2401.drop", "https://arxiv.org/pdf/2401.drop");

    const r = await fetcherNode({
      ...baseState,
      discoveredPapers: [a, b],
      // User checked one paper, dropped the other.
      discoveryApproved: { approved: true, keptExternalIds: [a.externalId] },
    });

    // Only the kept paper was downloaded + OCR'd.
    expect(mocks.parsePdfWithMistral).toHaveBeenCalledTimes(1);
    expect(mocks.corpusItemCreate).toHaveBeenCalledTimes(1);
    // Returned state.discoveredPapers contains ONLY the kept paper so the
    // screener (which loops over state.discoveredPapers) never bills on the
    // dropped one.
    expect(r.discoveredPapers).toHaveLength(1);
    expect(r.discoveredPapers![0]!.externalId).toBe(a.externalId);
    expect(r.discoveredPapers![0]!.corpusItemId).toBe("ci_kept");
  });

  it("falls back to fetching every discovered paper when keptExternalIds is undefined", async () => {
    // Approved-as-is path: user clicked "Approve N" without dropping
    // anything, so discoveryApproved is { approved: true } with no keptList.
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(null, { status: 403 }), // doesn't matter — we assert call count
    ));

    const a = openHit("2401.a", "https://arxiv.org/pdf/2401.a");
    const b = openHit("2401.b", "https://arxiv.org/pdf/2401.b");

    await fetcherNode({
      ...baseState,
      discoveredPapers: [a, b],
      discoveryApproved: { approved: true },
    });

    // Both papers were attempted (HEAD calls).
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("downloads + OCRs + persists CorpusItem for open papers", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init?: RequestInit) => {
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-type": "application/pdf", "content-length": String(pdfBytes.length) },
          });
        }
        return new Response(pdfBytes.buffer, { status: 200 });
      }),
    );
    mocks.corpusItemCreate.mockResolvedValueOnce({ id: "ci_x" });

    const r = await fetcherNode({
      ...baseState,
      discoveredPapers: [openHit("2310.06770", "https://arxiv.org/pdf/2310.06770")],
    });

    expect(mocks.putObject).toHaveBeenCalledTimes(1);
    expect(mocks.parsePdfWithMistral).toHaveBeenCalledTimes(1);
    expect(mocks.corpusItemCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "p1",
          kind: "PDF",
          status: "PARSED",
          source: "arxiv:arxiv:2310.06770",
          externalArxivId: "2310.06770",
          externalDoi: null,
          parsedMarkdown: "# Paper",
        }),
      }),
    );
    expect(mocks.discoveredPaperUpdate).toHaveBeenCalledWith({
      where: { id: "2310.06770" },
      data: { corpusItemId: "ci_x" },
    });
    expect(r.discoveredPapers).toHaveLength(1);
    expect(r.discoveredPapers![0]!.corpusItemId).toBe("ci_x");
  });

  it("classifies DOI-shaped externalId as externalDoi (not arxiv) for OpenAlex hits", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init?: RequestInit) =>
        init?.method === "HEAD"
          ? new Response(null, { status: 200, headers: { "content-type": "application/pdf" } })
          : new Response(pdfBytes.buffer, { status: 200 }),
      ),
    );

    await fetcherNode({
      ...baseState,
      discoveredPapers: [
        {
          id: "dp1",
          provider: "openalex",
          externalId: "10.1145/3641289.3641290",
          title: "DOI paper",
          abstract: null,
          oaUrl: "https://x.org/a.pdf",
          accessStatus: "open",
          corpusItemId: null,
        },
      ],
    });

    expect(mocks.corpusItemCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalDoi: "10.1145/3641289.3641290",
          externalArxivId: null,
        }),
      }),
    );
  });

  it("skips OpenAlex W-id hits when externalId is the prefixed form", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init?: RequestInit) =>
        init?.method === "HEAD"
          ? new Response(null, { status: 200, headers: { "content-type": "application/pdf" } })
          : new Response(pdfBytes.buffer, { status: 200 }),
      ),
    );

    await fetcherNode({
      ...baseState,
      discoveredPapers: [
        {
          id: "dp2",
          provider: "openalex",
          externalId: "openalex:W999",
          title: "No-DOI OpenAlex hit",
          abstract: null,
          oaUrl: "https://x.org/b.pdf",
          accessStatus: "open",
          corpusItemId: null,
        },
      ],
    });

    expect(mocks.corpusItemCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ externalDoi: null, externalArxivId: null }),
      }),
    );
  });

  it("does NOT throw on non-PDF / 4xx / oversized — non-fatal skip", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("Not Found", { status: 404 }),
      ),
    );

    const r = await fetcherNode({
      ...baseState,
      discoveredPapers: [openHit("404id", "https://example.org/missing.pdf")],
    });
    expect(mocks.parsePdfWithMistral).not.toHaveBeenCalled();
    expect(mocks.corpusItemCreate).not.toHaveBeenCalled();
    expect(r.discoveredPapers![0]!.corpusItemId).toBeNull();
  });

  it("respects bounded concurrency (does not start 9th before any of first 8 finish)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init?: RequestInit) => {
        if (init?.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-type": "application/pdf" } });
        }
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 });
      }),
    );

    const papers = Array.from({ length: 12 }, (_, i) =>
      openHit(`p${i}`, `https://example.org/${i}.pdf`),
    );
    await fetcherNode({ ...baseState, discoveredPapers: papers });
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it("skips papers that already have a corpusItemId (idempotent on retry)", async () => {
    const alreadyFetched: DiscoveredPaperRef = {
      ...openHit("dup", "https://x.org/dup.pdf"),
      corpusItemId: "ci_existing",
    };
    vi.stubGlobal("fetch", vi.fn());

    const r = await fetcherNode({
      ...baseState,
      discoveredPapers: [alreadyFetched],
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(r.discoveredPapers![0]!.corpusItemId).toBe("ci_existing");
  });
});

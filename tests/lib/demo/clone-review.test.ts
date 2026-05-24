import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    project: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { db } from "@/lib/db";
import { cloneReviewTemplate } from "@/lib/demo/clone-review";

type CreatedRow = { id: string; [k: string]: unknown };

/**
 * Build a tx mock that hands out predictable ids on .create calls and
 * records the data passed in so assertions can inspect it. createMany
 * just records and returns a count — we don't need actual ids back.
 */
function buildTxMock() {
  let projectCounter = 0;
  let corpusCounter = 0;
  let runCounter = 0;
  let includedCounter = 0;

  const calls = {
    projectCreate: [] as Array<{ data: Record<string, unknown> }>,
    corpusCreate: [] as Array<{ data: Record<string, unknown> }>,
    runCreate: [] as Array<{ data: Record<string, unknown> }>,
    includedCreate: [] as Array<{ data: Record<string, unknown> }>,
    runStepCreateMany: [] as Array<{ data: unknown[] }>,
    checkpointCreateMany: [] as Array<{ data: unknown[] }>,
    extractedClaimCreateMany: [] as Array<{ data: unknown[] }>,
    claimCheckCreateMany: [] as Array<{ data: unknown[] }>,
  };

  const tx = {
    project: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        calls.projectCreate.push(args);
        const id = `p_new_${++projectCounter}`;
        return { id, ...args.data } as CreatedRow;
      }),
    },
    corpusItem: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        calls.corpusCreate.push(args);
        const id = `c_new_${++corpusCounter}`;
        return { id, ...args.data } as CreatedRow;
      }),
    },
    run: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        calls.runCreate.push(args);
        const id = `r_new_${++runCounter}`;
        return { id, ...args.data } as CreatedRow;
      }),
    },
    runStep: {
      createMany: vi.fn(async (args: { data: unknown[] }) => {
        calls.runStepCreateMany.push(args);
        return { count: args.data.length };
      }),
    },
    humanCheckpoint: {
      createMany: vi.fn(async (args: { data: unknown[] }) => {
        calls.checkpointCreateMany.push(args);
        return { count: args.data.length };
      }),
    },
    includedPaper: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        calls.includedCreate.push(args);
        const id = `ip_new_${++includedCounter}`;
        return { id, ...args.data } as CreatedRow;
      }),
    },
    extractedClaim: {
      createMany: vi.fn(async (args: { data: unknown[] }) => {
        calls.extractedClaimCreateMany.push(args);
        return { count: args.data.length };
      }),
    },
    claimCheck: {
      createMany: vi.fn(async (args: { data: unknown[] }) => {
        calls.claimCheckCreateMany.push(args);
        return { count: args.data.length };
      }),
    },
  };

  return { tx, calls };
}

const baseTemplate = {
  id: "p_template",
  ownerId: "u_template_owner",
  title: "Sample SLR",
  question: "Does the ReAct prompting strategy improve reasoning?",
  corpus: [
    {
      id: "t_corpus_1",
      kind: "PDF",
      status: "PARSED",
      source: "s3://bucket/react.pdf",
      rawText: null,
      parsedMarkdown: "# ReAct paper\n…",
      failureReason: null,
      summary: { abstract: "…", studyType: "experiment", relevanceToSLR: "core" },
      summaryTraceUrl: null,
      summarisedAt: new Date("2026-01-01T00:00:00Z"),
    },
  ],
  runs: [
    {
      id: "t_run_1",
      status: "COMPLETED",
      question: "Does ReAct improve reasoning?",
      plan: { picoc: { population: "LLM agents" } },
      draft: "This [t_corpus_1] supports the claim.",
      failureReason: null,
      faithfulnessScore: 0.95,
      critiqueScore: 4.2,
      createdAt: new Date("2026-01-02T00:00:00Z"),
      completedAt: new Date("2026-01-02T01:00:00Z"),
      steps: [],
      checkpoints: [],
      includedPapers: [
        {
          id: "t_ip_1",
          corpusItemId: "t_corpus_1",
          relevanceScore: 0.9,
          inclusionReason: "directly relevant",
          createdAt: new Date("2026-01-02T00:10:00Z"),
        },
      ],
      claims: [],
      claimChecks: [
        {
          id: "t_cc_1",
          paperId: "t_corpus_1",
          claim: "ReAct outperforms baseline",
          verdict: "SUPPORTED",
          reason: "Table 2 reports +5 acc",
          paperExcerpt: "Table 2: ReAct = 70.1%",
          createdAt: new Date("2026-01-02T00:20:00Z"),
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cloneReviewTemplate", () => {
  it("rewrites ClaimCheck.paperId to the cloned corpus id (no silent fallback)", async () => {
    vi.mocked(db.project.findUnique).mockResolvedValue(
      structuredClone(baseTemplate) as never,
    );
    const { tx, calls } = buildTxMock();
    vi.mocked(db.$transaction).mockImplementation(
      async (cb: unknown) => (cb as (t: unknown) => unknown)(tx),
    );

    const res = await cloneReviewTemplate({
      templateProjectId: "p_template",
      targetOwnerId: "u_guest_1",
    });

    expect(res.projectId).toBe("p_new_1");
    expect(calls.claimCheckCreateMany).toHaveLength(1);

    const ccRows = calls.claimCheckCreateMany[0]!.data as Array<{ paperId: string }>;
    expect(ccRows[0]!.paperId).toBe("c_new_1");
    expect(ccRows[0]!.paperId).not.toBe("t_corpus_1");
  });

  it("rewrites [paper_id] citation tokens in the cloned draft", async () => {
    vi.mocked(db.project.findUnique).mockResolvedValue(
      structuredClone(baseTemplate) as never,
    );
    const { tx, calls } = buildTxMock();
    vi.mocked(db.$transaction).mockImplementation(
      async (cb: unknown) => (cb as (t: unknown) => unknown)(tx),
    );

    await cloneReviewTemplate({
      templateProjectId: "p_template",
      targetOwnerId: "u_guest_1",
    });

    expect(calls.runCreate).toHaveLength(1);
    const newDraft = calls.runCreate[0]!.data.draft;
    expect(newDraft).toBe("This [c_new_1] supports the claim.");
  });

  it("leaves non-citation bracketed text untouched in the draft", async () => {
    const tmpl = structuredClone(baseTemplate) as typeof baseTemplate;
    tmpl.runs[0]!.draft = "See [Figure 1] and [t_corpus_1] for details.";
    vi.mocked(db.project.findUnique).mockResolvedValue(tmpl as never);
    const { tx, calls } = buildTxMock();
    vi.mocked(db.$transaction).mockImplementation(
      async (cb: unknown) => (cb as (t: unknown) => unknown)(tx),
    );

    await cloneReviewTemplate({
      templateProjectId: "p_template",
      targetOwnerId: "u_guest_1",
    });

    const newDraft = calls.runCreate[0]!.data.draft;
    // [Figure 1] is too short / contains a space — left alone.
    // [t_corpus_1] is rewritten to the new id.
    expect(newDraft).toBe("See [Figure 1] and [c_new_1] for details.");
  });

  it("throws when a ClaimCheck.paperId has no mapping (cross-tenant guard)", async () => {
    const tmpl = structuredClone(baseTemplate) as typeof baseTemplate;
    tmpl.runs[0]!.claimChecks[0]!.paperId = "t_unmapped_xyz";
    vi.mocked(db.project.findUnique).mockResolvedValue(tmpl as never);
    const { tx } = buildTxMock();
    vi.mocked(db.$transaction).mockImplementation(
      async (cb: unknown) => (cb as (t: unknown) => unknown)(tx),
    );

    await expect(
      cloneReviewTemplate({
        templateProjectId: "p_template",
        targetOwnerId: "u_guest_1",
      }),
    ).rejects.toThrow(/Template integrity violation/);
  });

  it("rewrites corpus ids inside HumanCheckpoint.proposal JSON", async () => {
    const tmpl = structuredClone(baseTemplate) as typeof baseTemplate;
    tmpl.runs[0]!.checkpoints = [
      {
        id: "t_cp_1",
        kind: "APPROVE_PAPERS",
        status: "APPROVED",
        proposal: {
          kind: "APPROVE_PAPERS",
          includedPapers: [{ corpusItemId: "t_corpus_1", relevanceScore: 0.9 }],
        },
        decisionPayload: null,
        rejectionReason: null,
        waitToken: "tok_orig",
        createdAt: new Date("2026-01-02T00:30:00Z"),
        decidedAt: new Date("2026-01-02T00:31:00Z"),
      },
    ] as never;
    vi.mocked(db.project.findUnique).mockResolvedValue(tmpl as never);
    const { tx, calls } = buildTxMock();
    vi.mocked(db.$transaction).mockImplementation(
      async (cb: unknown) => (cb as (t: unknown) => unknown)(tx),
    );

    await cloneReviewTemplate({
      templateProjectId: "p_template",
      targetOwnerId: "u_guest_1",
    });

    expect(calls.checkpointCreateMany).toHaveLength(1);
    const cpRow = (
      calls.checkpointCreateMany[0]!.data as Array<{
        proposal: { kind: string; includedPapers: Array<{ corpusItemId: string }> };
        waitToken: unknown;
      }>
    )[0]!;
    expect(cpRow.proposal.includedPapers[0]!.corpusItemId).toBe("c_new_1");
    expect(cpRow.waitToken).toBeNull();
  });

  it("uses the caller's tx when provided (no self-opened transaction)", async () => {
    vi.mocked(db.project.findUnique).mockResolvedValue(
      structuredClone(baseTemplate) as never,
    );
    const { tx } = buildTxMock();

    const res = await cloneReviewTemplate({
      templateProjectId: "p_template",
      targetOwnerId: "u_guest_1",
      tx: tx as never,
    });

    expect(res.projectId).toBe("p_new_1");
    // Should NOT have opened its own transaction.
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

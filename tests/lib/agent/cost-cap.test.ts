import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  env: { MAX_TOKENS_PER_RUN: 1000 },
}));

vi.mock("@/lib/db", () => ({
  db: {
    runStep: {
      aggregate: mocks.aggregate,
    },
  },
}));

vi.mock("@/lib/env", () => ({ env: mocks.env }));

beforeEach(() => {
  mocks.aggregate.mockReset();
  mocks.env.MAX_TOKENS_PER_RUN = 1000;
});

describe("assertWithinBudget", () => {
  it("returns within-budget summary when tokens under limit", async () => {
    mocks.aggregate.mockResolvedValue({ _sum: { inputTokens: 100, outputTokens: 200 } });

    const { assertWithinBudget } = await import("@/lib/agent/cost-cap");
    const result = await assertWithinBudget("run_1");

    expect(result).toEqual({ tokensUsed: 300, limit: 1000 });
    expect(mocks.aggregate).toHaveBeenCalledWith({
      _sum: { inputTokens: true, outputTokens: true },
      where: { runId: "run_1" },
    });
  });

  it("throws BudgetExceededError when over limit", async () => {
    mocks.aggregate.mockResolvedValue({ _sum: { inputTokens: 3000, outputTokens: 2000 } });

    const { assertWithinBudget, BudgetExceededError } = await import("@/lib/agent/cost-cap");

    let caught: unknown;
    try {
      await assertWithinBudget("run_2");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
    const err = caught as InstanceType<typeof BudgetExceededError>;
    expect(err.runId).toBe("run_2");
    expect(err.tokensUsed).toBe(5000);
    expect(err.limit).toBe(1000);
    expect(err.message).toContain("5000");
    expect(err.message).toContain("1000");
  });

  it("handles aggregate returning null sums (no RunSteps finished yet)", async () => {
    mocks.aggregate.mockResolvedValue({ _sum: { inputTokens: null, outputTokens: null } });

    const { assertWithinBudget } = await import("@/lib/agent/cost-cap");
    const result = await assertWithinBudget("run_3");

    expect(result).toEqual({ tokensUsed: 0, limit: 1000 });
  });

  it("uses default 250000 limit when MAX_TOKENS_PER_RUN is the default", async () => {
    mocks.env.MAX_TOKENS_PER_RUN = 250_000;
    mocks.aggregate.mockResolvedValue({ _sum: { inputTokens: 250_000, outputTokens: 1 } });

    const { assertWithinBudget, BudgetExceededError } = await import("@/lib/agent/cost-cap");

    let caught: unknown;
    try {
      await assertWithinBudget("run_4");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
    const err = caught as InstanceType<typeof BudgetExceededError>;
    expect(err.tokensUsed).toBe(250_001);
    expect(err.limit).toBe(250_000);
  });
});

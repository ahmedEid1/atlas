import { db } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * Thrown by {@link assertWithinBudget} when the cumulative input+output tokens
 * recorded against a Run's RunSteps exceed `env.MAX_TOKENS_PER_RUN`.
 *
 * The graph nodes call `assertWithinBudget` BEFORE every paid `runLLM` call
 * (and inside per-paper loops). This error bubbles up through the LangGraph
 * invocation back to `trigger/run-review.ts`, whose catch block matches with
 * `instanceof BudgetExceededError` and converts the run to FAILED with a
 * budget-specific `failureReason`.
 *
 * Defense-in-depth: a runaway loop (e.g. drafter↔critic) can no longer blow
 * past any token budget — the cap fails closed.
 */
export class BudgetExceededError extends Error {
  readonly runId: string;
  readonly tokensUsed: number;
  readonly limit: number;
  constructor(args: { runId: string; tokensUsed: number; limit: number }) {
    super(
      `Run ${args.runId} exceeded token budget: ${args.tokensUsed} > ${args.limit}`,
    );
    this.name = "BudgetExceededError";
    this.runId = args.runId;
    this.tokensUsed = args.tokensUsed;
    this.limit = args.limit;
  }
}

/**
 * Pre-call budget check. Sums `inputTokens + outputTokens` across every
 * RunStep for the given run and compares to `env.MAX_TOKENS_PER_RUN`.
 *
 * Call this at the top of every node function and inside any per-item loop
 * that issues an LLM call (e.g. assessor's per-paper loop). Throws
 * {@link BudgetExceededError} if the run is over budget; otherwise returns
 * the current usage so callers can log/trace it if they wish.
 *
 * Note: RunStep token columns are populated by `finishStep` AFTER each call,
 * so this check sees the cumulative cost of all PREVIOUS completed steps. A
 * single in-flight call can still push us over by its own size, but we cap
 * before the NEXT one — bounded overshoot, not unbounded.
 */
export async function assertWithinBudget(
  runId: string,
): Promise<{ tokensUsed: number; limit: number }> {
  const limit = env.MAX_TOKENS_PER_RUN;
  const agg = await db.runStep.aggregate({
    _sum: { inputTokens: true, outputTokens: true },
    where: { runId },
  });
  const tokensUsed = (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
  if (tokensUsed > limit) {
    throw new BudgetExceededError({ runId, tokensUsed, limit });
  }
  return { tokensUsed, limit };
}

// Real implementation lands in Task 8 (runs DB helpers).
// This stub keeps Tasks 3-7 compilable while we develop nodes against a stable interface.
export async function addStep(_args: { runId: string; nodeName: string }): Promise<{ id: string }> {
  throw new Error("addStep stub — real impl in Task 8");
}
export async function finishStep(_args: {
  stepId: string;
  traceUrl?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  failureReason?: string;
}): Promise<void> {
  throw new Error("finishStep stub — real impl in Task 8");
}
export async function findCorpusMarkdown(_corpusItemId: string): Promise<string | null> {
  throw new Error("findCorpusMarkdown stub — real impl in Task 8");
}

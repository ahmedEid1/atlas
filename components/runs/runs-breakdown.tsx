import type { RunStatus } from "@/components/runs/run-status-pill";

const COMPLETED = new Set<RunStatus>(["COMPLETED"]);
const FAILED = new Set<RunStatus>(["REJECTED", "FAILED"]);
const ACTIVE = new Set<RunStatus>([
  "PENDING",
  "PLANNING",
  "AWAITING_PLAN_APPROVAL",
  "RETRIEVING",
  "AWAITING_PAPERS_APPROVAL",
  "ASSESSING",
  "DRAFTING",
  "DISCOVERING",
  "AWAITING_DISCOVERY_APPROVAL",
  "FETCHING",
  "SCREENING",
]);

/**
 * Bucket counts by terminal category. Used for the project page run
 * summary line. Exported for unit testing.
 *
 * Buckets: completed (COMPLETED), failed (REJECTED + FAILED — both
 * terminal-not-success), active (every non-terminal state). REJECTED
 * is grouped with FAILED rather than its own bucket because the
 * project-page summary is about "what happened", not "why" — failed +
 * rejected are both "didn't produce a draft".
 */
export function bucketRuns(runs: { status: RunStatus | string }[]): {
  completed: number;
  failed: number;
  active: number;
} {
  let completed = 0;
  let failed = 0;
  let active = 0;
  for (const r of runs) {
    const s = r.status as RunStatus;
    if (COMPLETED.has(s)) completed++;
    else if (FAILED.has(s)) failed++;
    else if (ACTIVE.has(s)) active++;
  }
  return { completed, failed, active };
}

/**
 * Render a one-line summary of run statuses for the project page.
 * Hides zero-count buckets so a fresh project doesn't read "0
 * completed · 0 active · 0 failed". Returns null if there's nothing
 * to show (caller should skip rendering).
 */
export function RunsBreakdown({ runs }: { runs: { status: RunStatus | string }[] }) {
  const { completed, failed, active } = bucketRuns(runs);
  const parts: string[] = [];
  if (completed > 0) parts.push(`${completed} completed`);
  if (active > 0) parts.push(`${active} in progress`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (parts.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground tabular-nums">{parts.join(" · ")}</p>
  );
}

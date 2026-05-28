type Step = {
  id: string;
  nodeName: string;
  startedAt: Date | string;
  endedAt: Date | string | null;
  traceUrl: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  failureReason: string | null;
};

/**
 * Format a millisecond duration as a compact human-readable string.
 * Examples: 0.4s · 12s · 1m 23s · 1h 5m. Negative values clamp to 0.
 * Exported for unit testing.
 */
export function formatStepDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) {
    return remSeconds === 0 ? `${minutes}m` : `${minutes}m ${remSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

/**
 * Renders a run's step timeline. Duration is computed at render time from
 * `startedAt` → `endedAt ?? now`. The run-detail page polls every 2s via
 * RefreshTick, so an in-progress step's duration ticks up naturally as
 * the page re-renders — no client-side timer needed here.
 */
export function RunStepList({ steps, nowMs }: { steps: Step[]; nowMs: number }) {
  if (steps.length === 0) return <p className="text-muted-foreground text-sm">No steps yet.</p>;

  // `nowMs` is passed in (rather than calling Date.now() here) because React 19's
  // purity rule blocks impure calls inside render. The run-detail server page
  // captures `Date.now()` once per request and forwards it; the page polls every
  // 2s via RefreshTick so in-progress durations tick up with each re-render.
  const now = nowMs;

  return (
    <ol className="space-y-2 text-sm">
      {steps.map((s) => {
        const startedMs = new Date(s.startedAt).getTime();
        const endedMs = s.endedAt ? new Date(s.endedAt).getTime() : now;
        const durationMs = endedMs - startedMs;
        const isLive = !s.endedAt;
        return (
          <li key={s.id} className="flex items-center justify-between rounded border bg-card px-3 py-2">
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-muted-foreground">
                {s.endedAt ? "✓" : "…"}
              </span>
              <span className="font-medium">{s.nodeName}</span>
              {s.failureReason && (
                <span className="text-destructive text-xs">{s.failureReason}</span>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span
                className={isLive ? "tabular-nums text-[var(--thoth-blue)]" : "tabular-nums"}
                aria-label={isLive ? `running for ${formatStepDuration(durationMs)}` : `took ${formatStepDuration(durationMs)}`}
              >
                {formatStepDuration(durationMs)}
              </span>
              <span>in {s.inputTokens} · out {s.outputTokens}</span>
              {s.traceUrl && (
                <a href={s.traceUrl} target="_blank" rel="noreferrer" className="underline">
                  trace ↗
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

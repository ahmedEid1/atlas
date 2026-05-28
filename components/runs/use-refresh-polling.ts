"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Polls `router.refresh()` every `intervalMs` while `enabled` is true.
 * Pauses when the tab is hidden + refreshes once on tab return so the
 * user always sees current state when they come back. When `enabled`
 * flips to false (e.g., the watched item reached a terminal state),
 * the interval is torn down and not re-armed.
 *
 * Replaces three near-identical inline effects:
 *   - RefreshTickList (run-status live updates)
 *   - CorpusItemList polling (PENDING/PARSING items)
 *   - any future "watch this row until it stops moving" surface
 *
 * The visibility pause is the load-bearing part: agent runs take
 * 5-15 minutes and corpus OCR takes 30-60s, so a backgrounded tab
 * polling at 2s would waste hundreds of Vercel function invocations
 * per run for no UI to update.
 *
 * Pass a stable string/number/bool for `enabled` — passing an
 * array/object would re-fire the effect on every render. Callers
 * typically derive `enabled` from a signature like
 * `statuses.map(...).join(",")` and check inside.
 */
export function useRefreshPolling(enabled: boolean, intervalMs: number = 2000): void {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;

    let intervalId: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (intervalId !== undefined) return;
      intervalId = setInterval(() => router.refresh(), intervalMs);
    };
    const stop = () => {
      if (intervalId === undefined) return;
      clearInterval(intervalId);
      intervalId = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs, router]);
}

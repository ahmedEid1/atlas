"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Polls `router.refresh()` every 2s while a Run is in a non-terminal state.
 * Pauses polling when the tab is hidden — agent runs take 5-15 minutes so
 * background-tab polling would otherwise waste a few hundred Vercel function
 * invocations per run, with no UI to update. Refreshes once immediately on
 * tab return so the user always sees current state.
 */
export function RefreshTick({ run }: { run: { status: string } }) {
  const router = useRouter();
  useEffect(() => {
    const terminal = ["COMPLETED", "REJECTED", "FAILED"];
    if (terminal.includes(run.status)) return;

    let intervalId: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (intervalId !== undefined) return;
      intervalId = setInterval(() => router.refresh(), 2000);
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
  }, [run.status, router]);
  return null;
}

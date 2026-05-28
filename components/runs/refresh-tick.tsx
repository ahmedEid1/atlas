"use client";

import { useRefreshPolling } from "./use-refresh-polling";

const TERMINAL = new Set(["COMPLETED", "REJECTED", "FAILED"]);

/**
 * Polls `router.refresh()` every 2s while a Run is in a non-terminal
 * state. Pauses polling when the tab is hidden — see
 * `useRefreshPolling` for the load-bearing visibility logic.
 */
export function RefreshTick({ run }: { run: { status: string } }) {
  return <RefreshTickList runs={[run]} />;
}

/**
 * Polls `router.refresh()` every 2s while ANY run in the list is in
 * a non-terminal state. Used on the project page so the runs list's
 * status pills stay live without a manual reload.
 */
export function RefreshTickList({ runs }: { runs: { status: string }[] }) {
  // Stable signature so the underlying effect only re-fires when
  // a status genuinely changes — not every server-page re-render
  // (which produces a fresh `runs` array reference each tick).
  const sig = runs.map((r) => r.status).join(",");
  const anyActive = sig
    .split(",")
    .some((s) => s !== "" && !TERMINAL.has(s));
  useRefreshPolling(anyActive);
  return null;
}

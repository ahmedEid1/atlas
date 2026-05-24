"use client";

import { useState } from "react";

/**
 * The primary CTA on the home page for unauthenticated visitors.
 *
 * Click → POST /api/demo/start → server creates a guest Clerk user,
 * deep-clones the sample review into their account, mints a sign-in
 * ticket → we redirect to the Clerk ticket URL, which auto-signs in
 * and bounces to /dashboard. End-to-end takes ~2–4 seconds, mostly
 * the Prisma clone transaction.
 */
export function DemoCtaButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/demo/start", { method: "POST" });
      const body = (await res.json()) as { signInUrl?: string; message?: string };
      if (!res.ok || !body.signInUrl) {
        throw new Error(body.message ?? "Could not start the demo.");
      }
      window.location.href = body.signInUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="inline-flex items-center gap-2 px-6 py-3 rounded-md bg-[var(--thoth-gold)] text-[var(--thoth-blue-ink)] text-sm font-medium tracking-wide hover:bg-[var(--thoth-gold-glow)] transition-colors shadow-[0_1px_0_rgba(0,0,0,0.04),0_3px_10px_-3px_rgba(201,169,97,0.45)] disabled:opacity-70 disabled:cursor-progress"
      >
        {busy ? (
          <>
            <span className="inline-block w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
            Preparing your demo…
          </>
        ) : (
          <>
            Try the live demo
            <span aria-hidden="true">→</span>
          </>
        )}
      </button>
      <p className="text-xs text-[var(--thoth-stone)] max-w-xs">
        No sign-up. We mint a 24-hour guest account preloaded with the ReAct
        paper review — draft, scores, and the full cite_check audit.
      </p>
      {error && (
        <p className="text-xs text-red-700 max-w-xs">
          {error} Try the regular sign-up flow below.
        </p>
      )}
    </div>
  );
}

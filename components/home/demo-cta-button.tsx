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
      const body = (await res.json().catch(() => ({}))) as {
        signInUrl?: string;
        message?: string;
        retryAfterSeconds?: number;
      };

      if (res.ok && body.signInUrl) {
        // Keep the spinner up through the redirect — a stuck spinner during
        // navigation is preferable to a flash of idle state.
        window.location.href = body.signInUrl;
        return;
      }

      // Non-2xx → per-status messaging, then reset busy so the user can retry.
      let message: string;
      switch (res.status) {
        case 429:
          message = `You've hit the demo limit. Try again in ${
            body.retryAfterSeconds ?? 60
          }s.`;
          break;
        case 403:
          message =
            "This request can't be processed from your browser. Try refreshing the page.";
          break;
        case 503:
          message =
            "The live demo isn't configured yet — try the sign-up flow instead.";
          break;
        case 500:
          message =
            body.message ?? "Could not set up the demo. Please try again or sign in.";
          break;
        default:
          message = body.message ?? "Something went wrong.";
      }
      setError(message);
      setBusy(false);
    } catch {
      setError(
        "Could not reach the demo service. Check your connection and try again."
      );
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="inline-flex items-center gap-2 px-6 py-3 rounded-md bg-[var(--thoth-gold)] text-[var(--thoth-blue-ink)] text-sm font-medium tracking-wide hover:bg-[var(--thoth-gold-glow)] transition-colors shadow-[0_1px_0_rgba(0,0,0,0.04),0_3px_10px_-3px_rgba(201,169,97,0.45)] disabled:opacity-70 disabled:cursor-progress focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--thoth-blue-ink)]"
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
        <div
          role="alert"
          aria-live="polite"
          className="border border-[var(--thoth-rule)] rounded-md p-3 mt-3 max-w-xs"
        >
          <p className="eyebrow text-[var(--thoth-warn)]">Demo unavailable</p>
          <p className="text-sm text-[var(--thoth-warn)] mt-1.5 leading-snug">
            {error}
          </p>
        </div>
      )}
    </div>
  );
}

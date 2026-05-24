"use client";

import { useEffect, useState } from "react";
// The legacy entry point keeps the familiar imperative useSignIn() shape
// (isLoaded / setActive / signIn.create returning a SignInResource) that
// every "consume a sign-in ticket" example in the Clerk docs uses.
// @clerk/nextjs's main entry switched to a signal-based reactive API in
// v7 — useful for live-binding forms but unnecessary for a one-shot
// ticket handoff like this.
import { useSignIn } from "@clerk/nextjs/legacy";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

/**
 * Demo sign-in handoff page.
 *
 * The /api/demo/start endpoint mints a Clerk sign-in token and sends the
 * browser here with ?ticket=<jwt>. We consume the ticket client-side via
 * Clerk's signIn.ticket() flow — this is the documented pattern for
 * ticket auth from your own application. Calling Clerk's accounts.dev
 * ticket URL directly works on shallow setups but bounces dev instances
 * through Clerk's `/default-redirect` fallback page when the destination
 * isn't whitelisted on the Clerk dashboard. Doing the handoff in our own
 * app sidesteps that and gives us a branded loading state instead of a
 * Clerk-flavoured intermediate page.
 *
 * On success: navigate to /dashboard.
 * On failure: show a brand-card error with a link back to /sign-in.
 */
export default function DemoHandoffPage() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const router = useRouter();
  const ticket = useSearchParams().get("ticket");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !signIn || !ticket) return;

    let cancelled = false;
    (async () => {
      try {
        // Create a sign-in attempt using the ticket strategy.
        const attempt = await signIn.create({
          strategy: "ticket",
          ticket,
        });
        if (cancelled) return;

        if (attempt.status === "complete" && attempt.createdSessionId) {
          // Activate the session, then navigate to the dashboard.
          await setActive({ session: attempt.createdSessionId });
          if (!cancelled) router.push("/dashboard");
          return;
        }

        setError(
          `Sign-in did not complete (status: ${attempt.status ?? "unknown"}). ` +
            "Try again or sign in to a real account.",
        );
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // Don't leak Clerk internals in the UI; log them and show a
        // generic but actionable message.
        console.error("[demo/handoff] signIn.ticket failed:", msg);
        setError(
          "Couldn't activate the demo session. The link may have expired (60s window). " +
            "Try clicking the demo button again.",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, signIn, ticket, setActive, router]);

  return (
    <main className="min-h-[60vh] grid place-items-center px-6">
      <div className="max-w-md w-full">
        {!ticket ? (
          <ErrorCard
            title="Missing demo ticket"
            body="This page expects a ?ticket=… query parameter — it's normally set by the demo button. Try starting the demo from the home page."
          />
        ) : error ? (
          <ErrorCard title="Demo handoff failed" body={error} />
        ) : (
          <div className="flex flex-col items-center gap-4 py-12 text-center">
            <span
              aria-hidden="true"
              className="inline-block w-5 h-5 border-2 border-[var(--thoth-blue)] border-t-transparent rounded-full animate-spin"
            />
            <p className="eyebrow text-[var(--thoth-stone)]">Preparing your demo</p>
            <p className="text-sm text-[var(--thoth-stone)] max-w-xs">
              Signing you into a sample-data guest account.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function ErrorCard({ title, body }: { title: string; body: string }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="border border-[var(--thoth-rule)] rounded-md p-5"
    >
      <p className="eyebrow text-[var(--thoth-warn)]">{title}</p>
      <p className="text-sm text-[var(--thoth-warn)] mt-2 leading-snug">{body}</p>
      <div className="mt-4 flex gap-3 text-sm">
        <Link
          href="/"
          className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
        >
          ← Home
        </Link>
        <Link
          href="/sign-in"
          className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
        >
          Sign in instead
        </Link>
      </div>
    </div>
  );
}

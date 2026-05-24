"use client";

import { Suspense, useEffect, useRef, useState } from "react";
// The legacy entry point keeps the familiar imperative useSignIn() shape
// (isLoaded / setActive / signIn.create returning a SignInResource) that
// every "consume a sign-in ticket" example in the Clerk docs uses.
// @clerk/nextjs's main entry switched to a signal-based reactive API in
// v7 — useful for live-binding forms but unnecessary for a one-shot
// ticket handoff like this.
import { useSignIn } from "@clerk/nextjs/legacy";
import { useUser } from "@clerk/nextjs";
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
 *
 * Wrapped in <Suspense> because useSearchParams() triggers Next.js's CSR
 * bailout during static prerender — Suspense is the documented escape
 * hatch (https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout).
 */
export default function DemoHandoffPage() {
  return (
    <Suspense fallback={<HandoffLoading />}>
      <DemoHandoffInner />
    </Suspense>
  );
}

function HandoffLoading() {
  return (
    <main className="min-h-[60vh] grid place-items-center px-6">
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <span
          aria-hidden="true"
          className="inline-block w-5 h-5 border-2 border-[var(--thoth-blue)] border-t-transparent rounded-full animate-spin"
        />
        <p className="eyebrow text-[var(--thoth-stone)]">Preparing your demo</p>
      </div>
    </main>
  );
}

function DemoHandoffInner() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const { isSignedIn } = useUser();
  const router = useRouter();
  const ticket = useSearchParams().get("ticket");
  const [error, setError] = useState<string | null>(null);
  // Ticket consumption must be exactly-once. React's effect can re-run
  // (Strict Mode double-invoke in dev; in prod, the `signIn` reference
  // changes after the first sign-in completes and re-triggers the effect)
  // — a second signIn.create with the same ticket throws because Clerk
  // marks tickets as consumed on first use, surfacing a misleading
  // "handoff failed" error AFTER the session was already created.
  const consumedRef = useRef(false);

  useEffect(() => {
    // Already signed in (either we just succeeded, or the user arrived
    // here with a pre-existing session) — head straight to the dashboard.
    // This also rescues the post-error case where the FIRST signIn.create
    // succeeded silently before the catch ran on a second invocation.
    if (isSignedIn) {
      router.push("/dashboard");
      return;
    }

    if (!isLoaded || !signIn || !ticket) return;
    if (consumedRef.current) return;
    consumedRef.current = true;

    (async () => {
      try {
        const attempt = await signIn.create({
          strategy: "ticket",
          ticket,
        });

        if (attempt.status === "complete" && attempt.createdSessionId) {
          await setActive({ session: attempt.createdSessionId });
          router.push("/dashboard");
          return;
        }

        setError(
          `Sign-in did not complete (status: ${attempt.status ?? "unknown"}). ` +
            "Try again or sign in to a real account.",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[demo/handoff] signIn.create failed:", msg);
        // If the failure was the harmless "ticket already consumed" race
        // (because Clerk's own session state turned isSignedIn=true
        // between renders), the isSignedIn effect above will navigate us
        // to /dashboard on the next render. Show the error only if we
        // genuinely aren't signed in after a short grace period.
        setTimeout(() => {
          if (!isSignedIn) {
            setError(
              "Couldn't activate the demo session. The link may have expired (60s window). " +
                "Try clicking the demo button again.",
            );
          }
        }, 600);
      }
    })();
  }, [isLoaded, signIn, ticket, setActive, router, isSignedIn]);

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
              Signing you into an anonymous guest account.
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

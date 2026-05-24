import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { DraftView } from "@/components/runs/draft-view";
import { CritiquePanel } from "@/components/runs/CritiquePanel";
import {
  CitationFaithfulnessWidget,
  type ClaimCheckRow,
} from "@/components/runs/CitationFaithfulnessWidget";

/**
 * Public read-only view of the pinned showcase review.
 *
 * Reads by the fixed showcase user's clerkId (`user_thoth_showcase`, seeded
 * by `scripts/seed-showcase-review.ts`). No auth required — this exists so
 * visitors can see exactly what a completed Thoth review looks like
 * (draft + critic score + per-claim cite_check verdicts including the
 * two deliberately-unsupported citations that demonstrate the audit's
 * value) without signing in or running the agent themselves.
 *
 * If the seed script hasn't been run on this database, the page returns
 * a 404 rather than crashing — easier to recover from than a hard error.
 */

const SHOWCASE_CLERK_ID = "user_thoth_showcase";

export const dynamic = "force-dynamic";

export default async function ShowcasePage() {
  const showcaseUser = await db.user.findUnique({
    where: { clerkId: SHOWCASE_CLERK_ID },
    select: { id: true },
  });
  if (!showcaseUser) notFound();

  const run = await db.run.findFirst({
    where: { project: { ownerId: showcaseUser.id }, status: "COMPLETED" },
    orderBy: { completedAt: "desc" },
    include: {
      project: { select: { title: true, question: true } },
      claimChecks: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!run) notFound();

  const supportedCount = run.claimChecks.filter((c) => c.verdict === "SUPPORTED").length;
  const unsupportedCount = run.claimChecks.filter((c) => c.verdict === "UNSUPPORTED").length;

  return (
    <main id="main" className="max-w-4xl mx-auto px-6 py-12 space-y-8">
      <header className="space-y-3">
        <p className="eyebrow text-[var(--thoth-stone)]">Reference review</p>
        <h1 className="font-display text-3xl md:text-4xl font-medium text-[var(--thoth-blue-ink)] leading-tight">
          {run.project.title}
        </h1>
        <p className="text-base text-[var(--thoth-stone)] max-w-3xl leading-snug">
          {run.project.question}
        </p>
        <div
          role="status"
          className="border border-[var(--thoth-rule)] rounded-md p-3 max-w-3xl bg-[color-mix(in_oklab,var(--thoth-gold)_8%,var(--thoth-papyrus))]"
        >
          <p className="text-xs text-[var(--thoth-blue-ink)] leading-snug">
            <strong>Showcase output.</strong> This is a pinned, read-only Thoth
            review held for reference — exactly what the live agent produces
            for any user, complete with the cite_check audit below. {unsupportedCount}{" "}
            of {run.claimChecks.length} citations were flagged as{" "}
            <em>unsupported</em> by cite_check ({supportedCount} supported); both
            unsupported entries are intentional examples of the model attaching
            fabricated facts to real papers — the exact failure mode the audit
            is designed to surface before the user reads the draft.
          </p>
          <p className="text-xs text-[var(--thoth-stone)] mt-2">
            Want to run your own?{" "}
            <Link href="/" className="text-[var(--thoth-blue)] hover:underline underline-offset-4">
              Try the live demo
            </Link>{" "}
            on the home page.
          </p>
        </div>
      </header>

      {(run.critiqueScore != null || run.faithfulnessScore != null) && (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <CritiquePanel critiqueScore={run.critiqueScore} />
          <CitationFaithfulnessWidget
            faithfulnessScore={run.faithfulnessScore}
            claimChecks={run.claimChecks as ClaimCheckRow[]}
          />
        </section>
      )}

      {run.draft && <DraftView draft={run.draft} />}
    </main>
  );
}

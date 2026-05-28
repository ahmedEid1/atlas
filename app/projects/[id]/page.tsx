import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Per-project tab title. Falls back to a generic copy when the project
 * is missing / not owned — same posture as the page handler (which
 * renders notFound() anyway), so leaking a richer title from an
 * existence-probe isn't possible.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const user = await requireUser().catch(() => null);
  if (!user) return { title: "Project" };
  const project = await db.project.findUnique({
    where: { id },
    select: { title: true, ownerId: true },
  });
  if (!project || project.ownerId !== user.id) return { title: "Project not found" };
  return { title: `${project.title} — Thoth` };
}
import { UploadButton } from "@/components/corpus/upload-button";
import { CorpusItemList } from "@/components/corpus/corpus-item-list";
import { StartReviewButton } from "@/components/runs/start-review-button";
import { RunStatusPill, type RunStatus } from "@/components/runs/run-status-pill";
import { EditProjectDialog } from "@/components/projects/edit-project-dialog";
import { DeleteRunButton } from "@/components/runs/delete-run-button";
import { DeleteProjectButton } from "@/components/projects/delete-project-button";
import { ProjectTokenStat } from "@/components/projects/project-token-stat";
import { RefreshTickList } from "@/components/runs/refresh-tick";
import { RunsBreakdown } from "@/components/runs/runs-breakdown";
import { relativeTime } from "@/lib/relative-time";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const project = await db.project.findUnique({
    where: { id },
    include: {
      corpus: { orderBy: { createdAt: "desc" } },
      runs: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
  if (!project || project.ownerId !== user.id) notFound();

  // Aggregate token usage across every RunStep of every run owned by
  // this project. Scoped at the project level (not just visible runs)
  // so the total is correct even for projects with >10 runs. Single
  // scalar sum query — Postgres handles it via the FK indexes on Run +
  // RunStep, so cheap.
  const tokenAgg = await db.runStep.aggregate({
    where: { run: { projectId: id } },
    _sum: { inputTokens: true, outputTokens: true, cacheReadInputTokens: true },
  });
  const projectTokens = {
    in: tokenAgg._sum.inputTokens ?? 0,
    out: tokenAgg._sum.outputTokens ?? 0,
    cache: tokenAgg._sum.cacheReadInputTokens ?? 0,
  };

  const scope = project.searchScope as "uploaded_only" | "outbound" | "hybrid";
  const isOutbound = scope === "outbound" || scope === "hybrid";
  const parsedCount = project.corpus.filter((c) => c.status === "PARSED").length;
  // Outbound projects don't need a pre-uploaded corpus — the discoverer builds
  // it. Hybrid + uploaded_only still need ≥1 PARSED item before the agent has
  // something to assess.
  const canStartReview = scope === "outbound" || parsedCount > 0;
  const SCOPE_LABEL: Record<typeof scope, string> = {
    uploaded_only: "Uploaded PDFs only",
    outbound: "Outbound search",
    hybrid: "Hybrid (uploaded + outbound)",
  };

  return (
    <main id="main" className="max-w-5xl mx-auto px-6 py-10 space-y-8">
      <header>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold">{project.title}</h1>
            <p className="text-muted-foreground mt-1">{project.question}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <EditProjectDialog
              project={{
                id: project.id,
                title: project.title,
                question: project.question,
                searchScope: scope,
                searchProviders: project.searchProviders,
                searchYearStart: project.searchYearStart,
                searchYearEnd: project.searchYearEnd,
                searchMaxHits: project.searchMaxHits,
                skipDiscoveryGate: project.skipDiscoveryGate,
              }}
            />
            <DeleteProjectButton
              projectId={project.id}
              projectTitle={project.title}
              variant="page"
            />
          </div>
        </div>
      </header>

      {isOutbound && (
        <section
          className="rounded-md border bg-[var(--thoth-blue-mist)]/30 px-4 py-3 text-sm"
          aria-labelledby="discovery-config-heading"
        >
          <h2 id="discovery-config-heading" className="font-medium text-[var(--thoth-blue-ink)]">
            Discovery configuration
          </h2>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Scope</dt>
              <dd className="font-medium">{SCOPE_LABEL[scope]}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Providers</dt>
              <dd className="font-mono">
                {project.searchProviders.length > 0
                  ? project.searchProviders.join(", ")
                  : <span className="italic text-muted-foreground">none configured</span>}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Max hits per run</dt>
              <dd>{project.searchMaxHits}</dd>
            </div>
            {(project.searchYearStart || project.searchYearEnd) && (
              <div className="col-span-2 sm:col-span-3">
                <dt className="text-muted-foreground">Year range</dt>
                <dd>
                  {project.searchYearStart ?? "—"}{" – "}{project.searchYearEnd ?? "—"}
                </dd>
              </div>
            )}
            {project.skipDiscoveryGate && (
              <div className="col-span-2 sm:col-span-3">
                <dt className="text-muted-foreground">HITL gate</dt>
                <dd className="italic">Discovery approval skipped (auto-approve)</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Corpus</h2>
          <UploadButton projectId={project.id} />
        </div>
        {scope === "outbound" && project.corpus.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Outbound projects don&apos;t need uploaded PDFs — the discoverer will build the
            corpus from your configured providers. You can still upload PDFs to seed the run;
            they&apos;ll be parsed and counted alongside the discovered ones.
          </p>
        ) : (
          <CorpusItemList items={project.corpus as unknown as Parameters<typeof CorpusItemList>[0]["items"]} />
        )}
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-medium">Reviews</h2>
            <ProjectTokenStat tokens={projectTokens} />
          </div>
          <StartReviewButton projectId={project.id} disabled={!canStartReview} />
        </div>
        <RunsBreakdown runs={project.runs} />
        {project.runs.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {scope === "outbound"
              ? "No reviews yet. Start one — the agent will discover candidate papers, screen them, then draft the review."
              : "No reviews yet. Start one once at least one paper is parsed."}
          </p>
        ) : (
          <ul className="space-y-2">
            <RefreshTickList runs={project.runs.map((r) => ({ status: r.status }))} />
            {(() => {
              // eslint-disable-next-line react-hooks/purity -- server-render snapshot for the per-row "Started X ago" label.
              const nowMs = Date.now();
              return project.runs.map((r) => {
                const startedAt = new Date(r.createdAt);
                const absolute = startedAt.toLocaleString();
                return (
                  <li key={r.id} className="flex items-stretch gap-2">
                    <Link
                      href={`/projects/${project.id}/runs/${r.id}`}
                      className="flex flex-1 items-center justify-between rounded border bg-card p-3 hover:bg-accent"
                    >
                      <span className="text-sm truncate">
                        <time dateTime={startedAt.toISOString()} title={absolute}>
                          Started {relativeTime(startedAt.getTime(), nowMs)}
                        </time>
                      </span>
                      <RunStatusPill status={r.status as RunStatus} />
                    </Link>
                    <div className="flex items-center px-2">
                      <DeleteRunButton runId={r.id} runLabel={absolute} />
                    </div>
                  </li>
                );
              });
            })()}
          </ul>
        )}
      </section>
    </main>
  );
}

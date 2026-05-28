import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { ProjectList } from "@/components/projects/project-list";
import { NewProjectDialog } from "@/components/projects/new-project-dialog";

export default async function DashboardPage() {
  const user = await requireUser();
  const projects = await db.project.findMany({
    where: { ownerId: user.id },
    orderBy: { updatedAt: "desc" },
    // Count corpus + runs per row so the list eyebrow can show
    // "3 papers · 1 review" without an N+1 fan-out. _count is a
    // single Postgres scalar subquery per relation in Prisma.
    include: {
      _count: { select: { corpus: true, runs: true } },
      // Latest run's status so the row can render a small status pill
      // matching what the project-detail page would show. take: 1 +
      // orderBy: createdAt desc is cheap thanks to the [projectId,
      // createdAt] index implied by the FK + the orderBy.
      runs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true, createdAt: true },
      },
    },
  });

  return (
    <main id="main" className="max-w-5xl mx-auto px-6 py-16">
      <header className="flex items-end justify-between gap-6 flex-wrap mb-12">
        <div>
          <p className="eyebrow">Your work</p>
          <h1
            className="font-display text-[var(--thoth-blue-ink)] mt-3 leading-[1.0] tracking-tight"
            style={{
              fontSize: "clamp(2.25rem, 5vw, 3.25rem)",
              fontWeight: 500,
              fontVariationSettings: "'opsz' 96",
            }}
          >
            Reviews
          </h1>
          <p className="text-sm text-[var(--thoth-stone)] mt-2 max-w-md">
            {projects.length === 0
              ? "Start your first review by giving Thoth a research question and a corpus."
              : `${projects.length} review${
                  projects.length === 1 ? "" : "s"
                }, ordered by most recently updated.`}
          </p>
        </div>
        <NewProjectDialog />
      </header>

      {/* eslint-disable-next-line react-hooks/purity -- server-render
          snapshot for relative-time labels. */}
      <ProjectList projects={projects} nowMs={Date.now()} />
    </main>
  );
}

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { ProjectList } from "@/components/projects/project-list";
import { NewProjectDialog } from "@/components/projects/new-project-dialog";

export default async function DashboardPage() {
  const user = await requireUser();
  const projects = await db.project.findMany({
    where: { ownerId: user.id },
    orderBy: { updatedAt: "desc" },
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

      <ProjectList projects={projects} />
    </main>
  );
}

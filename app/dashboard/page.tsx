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
    <main className="max-w-5xl mx-auto px-6 py-10 space-y-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your projects</h1>
        <NewProjectDialog />
      </header>
      <ProjectList projects={projects} />
    </main>
  );
}

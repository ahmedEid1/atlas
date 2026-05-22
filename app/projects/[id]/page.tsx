import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { UploadButton } from "@/components/corpus/upload-button";
import { CorpusItemList } from "@/components/corpus/corpus-item-list";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const project = await db.project.findUnique({
    where: { id },
    include: { corpus: { orderBy: { createdAt: "desc" } } },
  });
  if (!project || project.ownerId !== user.id) notFound();

  return (
    <main className="max-w-5xl mx-auto px-6 py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">{project.title}</h1>
        <p className="text-muted-foreground mt-1">{project.question}</p>
      </header>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Corpus</h2>
          <UploadButton projectId={project.id} />
        </div>
        <CorpusItemList items={project.corpus} />
      </section>
    </main>
  );
}

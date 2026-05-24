import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { UploadButton } from "@/components/corpus/upload-button";
import { CorpusItemList } from "@/components/corpus/corpus-item-list";
import { StartReviewButton } from "@/components/runs/start-review-button";
import { RunStatusPill, type RunStatus } from "@/components/runs/run-status-pill";

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

  return (
    <main id="main" className="max-w-5xl mx-auto px-6 py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">{project.title}</h1>
        <p className="text-muted-foreground mt-1">{project.question}</p>
      </header>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Corpus</h2>
          <UploadButton projectId={project.id} />
        </div>
        <CorpusItemList items={project.corpus as unknown as Parameters<typeof CorpusItemList>[0]["items"]} />
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Reviews</h2>
          <StartReviewButton
            projectId={project.id}
            disabled={project.corpus.filter((c) => c.status === "PARSED").length === 0}
          />
        </div>
        {project.runs.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No reviews yet. Start one once at least one paper is parsed.
          </p>
        ) : (
          <ul className="space-y-2">
            {project.runs.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/projects/${project.id}/runs/${r.id}`}
                  className="flex items-center justify-between rounded border bg-card p-3 hover:bg-accent"
                >
                  <span className="text-sm truncate">{new Date(r.createdAt).toLocaleString()}</span>
                  <RunStatusPill status={r.status as RunStatus} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

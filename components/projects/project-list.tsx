import Link from "next/link";

type Project = {
  id: string;
  title: string;
  question: string;
  updatedAt: Date;
};

/**
 * Editorial project list. Each row reads like a journal-article card:
 * eyebrow with the updated date, title in Fraunces, research question
 * as the deck. Hover lifts the title color to Thoth blue and reveals a
 * small "open →" affordance on the right.
 */
export function ProjectList({ projects }: { projects: Project[] }) {
  if (projects.length === 0) {
    return (
      <div className="rule pt-10 text-center">
        <p className="font-display text-2xl text-[var(--thoth-blue-ink)] mb-2">
          No reviews yet.
        </p>
        <p className="text-sm text-[var(--thoth-stone)] max-w-md mx-auto">
          Create your first project above — give it a title, a research
          question, and a corpus, and Thoth will plan, retrieve, draft, and
          cite_check the review for you.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-[var(--thoth-rule)] border-y border-[var(--thoth-rule)]">
      {projects.map((p) => (
        <li key={p.id} className="group">
          <Link
            href={`/projects/${p.id}`}
            className="flex items-start gap-6 py-6 px-1 transition-colors hover:bg-[var(--thoth-blue-mist)]/20"
          >
            <div className="flex-1 min-w-0">
              <p className="eyebrow mb-2">
                Updated{" "}
                <time className="text-[var(--thoth-blue-ink)] tabular-nums">
                  {new Date(p.updatedAt).toLocaleDateString("en-GB", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </time>
              </p>
              <h2
                className="font-display text-[1.6rem] leading-tight text-[var(--thoth-blue-ink)] group-hover:text-[var(--thoth-blue)] transition-colors"
                style={{ fontWeight: 500, fontVariationSettings: "'opsz' 72" }}
              >
                {p.title}
              </h2>
              <p className="text-sm text-[var(--thoth-stone)] mt-2 line-clamp-2 leading-relaxed">
                {p.question}
              </p>
            </div>
            <span
              aria-hidden="true"
              className="text-[var(--thoth-stone)] opacity-0 group-hover:opacity-100 group-hover:text-[var(--thoth-blue)] transition-all translate-x-0 group-hover:translate-x-1 mt-7"
            >
              →
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

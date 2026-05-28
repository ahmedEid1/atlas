import Link from "next/link";
import { DeleteProjectButton } from "./delete-project-button";
import { RunStatusPill, type RunStatus } from "@/components/runs/run-status-pill";
import { relativeTime } from "@/lib/relative-time";

type Project = {
  id: string;
  title: string;
  question: string;
  updatedAt: Date;
  // V2 — optional so the showcase project (built from a v1-shape fixture)
  // and any other v1-style caller can omit them without lighting up "unknown".
  searchScope?: "uploaded_only" | "outbound" | "hybrid";
  // Counts of related rows. Optional for the same showcase-fixture
  // forward-compat reason — the editorial card just hides the line
  // when counts aren't passed.
  _count?: { corpus: number; runs: number };
  // Latest run, if any. Used to render a small status pill next to
  // the title so users see at-a-glance whether the project's most
  // recent run is COMPLETED / RUNNING / FAILED. Optional for the same
  // showcase-fixture forward-compat reason.
  runs?: { status: string; createdAt: Date | string }[];
};

function countsLine(counts: { corpus: number; runs: number }): string {
  const c = counts.corpus;
  const r = counts.runs;
  const corpusLabel = c === 1 ? "1 paper" : `${c} papers`;
  const runLabel = r === 1 ? "1 review" : `${r} reviews`;
  return `${corpusLabel} · ${runLabel}`;
}

export { countsLine };

/**
 * Editorial project list. Each row reads like a journal-article card:
 * eyebrow with the updated date, title in Fraunces, research question
 * as the deck. Hover lifts the title color to Thoth blue and reveals a
 * small "open →" affordance on the right.
 */
export function ProjectList({ projects, nowMs }: { projects: Project[]; nowMs?: number }) {
  // `nowMs` is server-passed (vs Date.now() in render) so the eyebrow
  // "Updated 2 days ago" copy stays referentially pure. Caller can omit
  // for legacy / showcase fixtures — falls back to the absolute date.
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
        <li key={p.id} className="group relative">
          <Link
            href={`/projects/${p.id}`}
            className="flex items-start gap-6 py-6 px-1 transition-colors hover:bg-[var(--thoth-blue-mist)]/20"
          >
            <div className="flex-1 min-w-0">
              <p className="eyebrow mb-2">
                Updated{" "}
                <time
                  dateTime={new Date(p.updatedAt).toISOString()}
                  title={new Date(p.updatedAt).toLocaleString("en-GB", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  className="text-[var(--thoth-blue-ink)] tabular-nums"
                >
                  {nowMs !== undefined
                    ? relativeTime(new Date(p.updatedAt).getTime(), nowMs)
                    : new Date(p.updatedAt).toLocaleDateString("en-GB", {
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
                {(p.searchScope === "outbound" || p.searchScope === "hybrid") && (
                  <span
                    className="ml-2 align-middle text-[0.6rem] font-sans font-medium uppercase tracking-wider text-[var(--thoth-blue)] bg-[var(--thoth-blue-mist)]/50 px-1.5 py-0.5 rounded"
                    title={p.searchScope === "outbound" ? "Outbound search" : "Hybrid (uploaded + outbound)"}
                  >
                    {p.searchScope === "hybrid" ? "hybrid" : "v2"}
                  </span>
                )}
                {p.runs && p.runs.length > 0 && p.runs[0] && (
                  <span className="ml-2 align-middle inline-flex">
                    <RunStatusPill status={p.runs[0].status as RunStatus} />
                  </span>
                )}
              </h2>
              <p className="text-sm text-[var(--thoth-stone)] mt-2 line-clamp-2 leading-relaxed">
                {p.question}
              </p>
              {p._count && (
                <p className="text-xs text-[var(--thoth-stone)]/80 mt-2 tabular-nums">
                  {countsLine(p._count)}
                </p>
              )}
            </div>
            <span
              aria-hidden="true"
              className="text-[var(--thoth-stone)] opacity-0 group-hover:opacity-100 group-hover:text-[var(--thoth-blue)] transition-all translate-x-0 group-hover:translate-x-1 mt-7"
            >
              →
            </span>
          </Link>
          {/* Absolute-positioned outside the <Link> so the delete button
              isn't a nested interactive element. opacity-0 → group-hover:opacity-100
              keeps the editorial look clean until the user mouses over. */}
          <div className="absolute top-6 right-1 pointer-events-auto">
            <DeleteProjectButton projectId={p.id} projectTitle={p.title} />
          </div>
        </li>
      ))}
    </ul>
  );
}

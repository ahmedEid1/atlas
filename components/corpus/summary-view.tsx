"use client";

import { Badge } from "@/components/ui/badge";

export type PaperSummary = {
  abstract: string;
  researchQuestions: string[];
  methodology: string;
  keyFindings: string[];
  limitations: string[];
  studyType:
    | "empirical"
    | "experiment"
    | "case_study"
    | "survey"
    | "review"
    | "theoretical"
    | "other";
  relevanceToSLR: "highly_relevant" | "relevant" | "tangential" | "off_topic";
};

const RELEVANCE_VARIANT: Record<
  PaperSummary["relevanceToSLR"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  highly_relevant: "default",
  relevant: "secondary",
  tangential: "outline",
  off_topic: "destructive",
};

export function SummaryView({
  summary,
  traceUrl,
}: {
  summary: PaperSummary;
  traceUrl: string | null;
}) {
  return (
    <div className="mt-4 space-y-4 rounded border bg-card p-4 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant={RELEVANCE_VARIANT[summary.relevanceToSLR]}>
          {summary.relevanceToSLR.replace(/_/g, " ")}
        </Badge>
        <Badge variant="outline">{summary.studyType.replace(/_/g, " ")}</Badge>
        {traceUrl && (
          <a
            href={traceUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-xs underline text-muted-foreground hover:text-foreground"
          >
            View trace ↗
          </a>
        )}
      </div>

      <section>
        <h4 className="font-medium mb-1">Abstract</h4>
        <p className="text-muted-foreground leading-relaxed">{summary.abstract}</p>
      </section>

      {summary.researchQuestions.length > 0 && (
        <section>
          <h4 className="font-medium mb-1">Research questions</h4>
          <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
            {summary.researchQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4 className="font-medium mb-1">Methodology</h4>
        <p className="text-muted-foreground leading-relaxed">{summary.methodology}</p>
      </section>

      {summary.keyFindings.length > 0 && (
        <section>
          <h4 className="font-medium mb-1">Key findings</h4>
          <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
            {summary.keyFindings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </section>
      )}

      {summary.limitations.length > 0 && (
        <section>
          <h4 className="font-medium mb-1">Limitations</h4>
          <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
            {summary.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

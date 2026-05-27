import { z } from "zod";

const PaperSchema = z.object({
  id: z.string().min(1).describe("Unique paper id within this question (e.g., 'paper_001')"),
  title: z.string().min(1),
  summary: z.string().min(1).describe("M2-style structured summary text used by cite_check and assessor"),
  markdown: z.string().min(1).describe("Full paper text used by retriever"),
});

const PicocSchema = z.object({
  population: z.string().min(1),
  intervention: z.string().min(1),
  comparison: z.string().min(1),
  outcome: z.string().min(1),
  context: z.string().min(1),
});

const MetadataSchema = z.object({
  source: z.string().min(1).describe("Reference review / DOI / URL"),
  difficulty: z.enum(["easy", "medium", "hard"]),
});

export const GoldenQuestionSchema = z
  .object({
    id: z.string().regex(/^[0-9]{3}-[a-z0-9-]+$/, "id must look like '000-slug'"),
    question: z.string().min(10),
    picoc: PicocSchema,
    papers: z.array(PaperSchema).min(1, "at least one paper is required"),
    expectedPapers: z.array(z.string().min(1)).min(1),
    expectedClaims: z.array(z.string().min(1)).min(1),
    // V2 — optional list of expected external ids (DOIs / arXiv ids /
    // OpenAlex W-ids) for outbound goldens. When set, the eval CLI
    // computes discovery_recall + screening_precision against this list;
    // when undefined (every existing V1 golden), those metrics are
    // skipped so the dashboard doesn't fill with vacuous 1.00 rows.
    expectedDois: z.array(z.string().min(3)).optional(),
    metadata: MetadataSchema,
  })
  // `papers[].id` must be unique within the question — `lib/eval/seed-corpus.ts`
  // builds a Map<paper.id, corpusItem.id> and a duplicate paper id would
  // silently overwrite the earlier entry, dropping a paper from the seeded
  // corpus. None of the existing 17 goldens have duplicates today; the
  // refine keeps that invariant intact going forward.
  .refine(
    (g) => new Set(g.papers.map((p) => p.id)).size === g.papers.length,
    { message: "papers[].id must be unique within the question" },
  )
  .refine(
    (g) => {
      const paperIds = new Set(g.papers.map((p) => p.id));
      return g.expectedPapers.every((id) => paperIds.has(id));
    },
    { message: "expectedPapers must all reference ids declared in papers[]" },
  );

export type GoldenQuestion = z.infer<typeof GoldenQuestionSchema>;

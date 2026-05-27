import { Annotation } from "@langchain/langgraph";

/** A subset of CorpusItem useful for the agent — never the full markdown to keep prompts small. */
export type CandidateCorpusItem = {
  id: string;
  title: string;
  summary: {
    abstract: string;
    studyType: string;
    relevanceToSLR: string;
  } | null;
};

/**
 * V2 — a paper discovered by the outbound search pipeline. Carried in state
 * between the discoverer node (which writes it from search-provider hits) and
 * the screener node (which produces a ScreeningDecision for each one).
 *
 * `corpusItemId` is `null` until the fetcher successfully downloads + OCRs
 * the PDF; the screener can score abstract-only when this stays null.
 */
export type DiscoveredPaperRef = {
  id: string;                              // DB row id (DiscoveredPaper.id)
  // "uploaded" is the synthetic provider used in hybrid mode for
  // user-uploaded PARSED CorpusItems that the discoverer wraps into the
  // discovery flow so the screener evaluates them alongside outbound hits.
  provider: "openalex" | "arxiv" | "exa" | "uploaded";
  externalId: string;
  title: string;
  abstract: string | null;
  oaUrl: string | null;
  accessStatus: "open" | "paywalled" | "unknown";
  corpusItemId: string | null;
};

/** V2 — screener's per-paper verdict. */
export type ScreeningRef = {
  discoveredPaperId: string;
  include: boolean;
  relevanceScore: number;
  reason: string;
};

export type SearchScope = "uploaded_only" | "outbound" | "hybrid";

export type Plan = {
  picoc: {
    population: string;
    intervention: string;
    comparison: string;
    outcome: string;
    context: string;
  };
  subQuestions: string[];
  inclusionCriteria: string[];
  exclusionCriteria: string[];
};

export type IncludedPaperSpec = {
  corpusItemId: string;
  relevanceScore: number;
  inclusionReason: string;
};

export type ClaimSpec = {
  includedPaperId: string;
  text: string;
  category: "finding" | "methodology" | "limitation" | "context";
};

export type Critique = {
  rubric: {
    faithfulness: number;
    completeness: number;
    citationQuality: number;
    clarity: number;
  };
  overallScore: number;
  actionableFeedback: string;
  decision: "approve" | "revise";
};

/**
 * Shared state that flows through the agent graph.
 * - `planApproved` / `papersApproved` are HITL gate decisions; `null` means "not asked yet"
 * - The reducer pattern (with `default: () => []`) is needed for arrays so partial state
 *   updates from a node don't blow away the previous value.
 */
export const AgentStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  projectId: Annotation<string>(),
  question: Annotation<string>(),
  candidateCorpusItems: Annotation<CandidateCorpusItem[]>({
    reducer: (_old, neu) => neu,
    default: () => [],
  }),
  plan: Annotation<Plan | null>({
    reducer: (_old, neu) => neu,
    default: () => null,
  }),
  planApproved: Annotation<{ approved: boolean; editedPlan?: Plan; rejectionReason?: string } | null>({
    reducer: (_old, neu) => neu,
    default: () => null,
  }),
  includedPapers: Annotation<IncludedPaperSpec[]>({
    reducer: (_old, neu) => neu,
    default: () => [],
  }),
  papersApproved: Annotation<{ approved: boolean; corpusItemIds?: string[]; rejectionReason?: string } | null>({
    reducer: (_old, neu) => neu,
    default: () => null,
  }),
  claims: Annotation<ClaimSpec[]>({
    reducer: (_old, neu) => neu,
    default: () => [],
  }),
  draft: Annotation<string | null>({
    reducer: (_old, neu) => neu,
    default: () => null,
  }),
  critique: Annotation<Critique | null>({
    reducer: (_old, neu) => neu,
    default: () => null,
  }),
  critiqueIterations: Annotation<number>({
    reducer: (_old, neu) => neu,
    default: () => 0,
  }),
  // V2 — outbound-search state. Carried only when the project has
  // searchScope !== "uploaded_only". V1 paths leave these defaulted.
  searchScope: Annotation<SearchScope>({
    reducer: (_old, neu) => neu,
    default: () => "uploaded_only",
  }),
  searchProviders: Annotation<Array<"openalex" | "arxiv" | "exa">>({
    reducer: (_old, neu) => neu,
    default: () => [],
  }),
  // Per-project cap on how many discovered hits make it past dedup into the
  // fetcher loop. Bounded by env.MAX_DISCOVERED_PAPERS_PER_RUN at runtime
  // (the smaller of the two wins), so a project author cannot exceed the
  // operator's ceiling. Null = use the env default.
  searchMaxHits: Annotation<number | null>({
    reducer: (_old, neu) => neu,
    default: () => null,
  }),
  discoveryQueries: Annotation<string[]>({
    reducer: (_old, neu) => neu,
    default: () => [],
  }),
  discoveredPapers: Annotation<DiscoveredPaperRef[]>({
    reducer: (_old, neu) => neu,
    default: () => [],
  }),
  discoveryApproved: Annotation<{
    approved: boolean;
    keptExternalIds?: string[];
    editedQueries?: string[];
    rejectionReason?: string;
  } | null>({
    reducer: (_old, neu) => neu,
    default: () => null,
  }),
  screeningDecisions: Annotation<ScreeningRef[]>({
    reducer: (_old, neu) => neu,
    default: () => [],
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;

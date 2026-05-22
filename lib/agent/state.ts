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
});

export type AgentState = typeof AgentStateAnnotation.State;

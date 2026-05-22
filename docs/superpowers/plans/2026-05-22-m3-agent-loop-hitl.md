# Atlas M3: Full Agent Loop + HITL Gates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a four-node LangGraph agent (planner → retriever → assessor → drafter) with two human-in-the-loop approval gates (approve plan, approve included papers), persisted via a Postgres checkpointer, driven by a Trigger.dev task using `wait.forToken()` so the run survives HITL pauses across server restarts. UI lets a user start a review on a project, watch progress live, approve/reject at each gate, and read the final draft with inline `[paper_id]` citations.

**Architecture:** LangGraph defines the state machine and node functions. A single Trigger.dev `run-review` task is the durability wrapper — it `invoke()`s the graph, detects `interrupt()`, persists the pending checkpoint to our `HumanCheckpoint` table, calls `wait.forToken()` to pause, then resumes with `Command.resume()` when the UI approves. State is double-persisted: LangGraph's PostgresSaver for resumability + our own Run/RunStep tables for the UI to query. Every LLM call goes through the M2 `runLLM` wrapper — same Langfuse trace + structured output + cost capture. No web search, no embeddings — the retriever operates on the project's existing PARSED+summarised corpus items. All Anthropic calls mocked in tests; live smoke deferred per project rule.

**Tech Stack:** Net new in M3: `@langchain/langgraph` (TypeScript), `@langchain/langgraph-checkpoint-postgres`. Everything else reuses M1/M2: Anthropic SDK via `lib/llm.ts`, Langfuse self-hosted, Trigger.dev v4 (`wait.forToken`, realtime), Prisma v7, Next.js 16, Vitest. **Out of scope** for M3: pgvector, Exa web search, OpenAlex, cite_check, real LLM smoke (M4+).

**Reference spec:** `agentic-ai/atlas/docs/superpowers/specs/2026-05-22-atlas-design.md` — §4.3 invariants (especially "HITL gates are blocking", "all LLM output Zod-validated", "every LLM call traced", "memory project-scoped"), §5 (agent loop), §10 (memory model — conversation + project layers used here), §12 (M3 line).

---

## What you need from Ahmed

**Nothing to start.** Same as M2: all tests mocked, no real Claude calls. Live smoke deferred until an `ANTHROPIC_API_KEY` is provided.

---

## File map

**Modified in this milestone:**
```
agentic-ai/atlas/
├── prisma/schema.prisma                                    # add Run, RunStep, HumanCheckpoint, IncludedPaper, ExtractedClaim
├── lib/trigger-client.ts                                   # add enqueueRunReview, resumeRun
├── app/projects/[id]/page.tsx                              # add "Start review" button
└── components/corpus/corpus-item-list.tsx                  # (unchanged — listed only for reference)
```

**New in this milestone:**
```
agentic-ai/atlas/
├── prisma/migrations/<ts>_add_review_run/migration.sql

├── lib/agent/
│   ├── state.ts                # Zod-typed shared state shape used across nodes
│   ├── graph.ts                # StateGraph composition + checkpointer setup
│   ├── checkpointer.ts         # PostgresSaver wrapper (lazy, env-driven)
│   ├── runs.ts                 # DB helpers — createRun, addStep, addCheckpoint, finishRun
│   └── nodes/
│       ├── planner.ts          # runs lib/llm with planner schema + prompt
│       ├── retriever.ts        # scores candidate corpus items against plan via LLM
│       ├── assessor.ts         # extracts claims from approved papers
│       └── drafter.ts          # composes draft sections with [paper_id] citations
├── lib/prompts/
│   ├── plan-review.ts          # planner schema + prompt builder
│   ├── score-paper.ts          # retriever schema + prompt builder (per-paper relevance)
│   ├── extract-claims.ts       # assessor schema + prompt builder
│   └── draft-review.ts         # drafter schema + prompt builder

├── trigger/run-review.ts       # the durability wrapper: invokes graph in loop, handles interrupts

├── app/api/projects/[id]/runs/route.ts                     # POST start a new run, GET list runs
├── app/api/runs/[id]/route.ts                              # GET single run with steps + checkpoints
├── app/api/runs/[id]/checkpoints/[cpId]/approve/route.ts   # POST approve a gate
├── app/api/runs/[id]/checkpoints/[cpId]/reject/route.ts    # POST reject + reason

├── app/projects/[id]/runs/[runId]/page.tsx                 # run workspace
├── components/runs/
│   ├── start-review-button.tsx
│   ├── run-status-pill.tsx
│   ├── run-step-list.tsx
│   ├── plan-approval-card.tsx
│   ├── papers-approval-card.tsx
│   └── draft-view.tsx

└── tests/
    ├── lib/agent/
    │   ├── nodes/planner.test.ts
    │   ├── nodes/retriever.test.ts
    │   ├── nodes/assessor.test.ts
    │   ├── nodes/drafter.test.ts
    │   ├── graph.test.ts           # integration: full traversal with mocked LLMs + mocked HITL
    │   └── runs.test.ts            # DB helper tests
    ├── lib/prompts/
    │   ├── plan-review.test.ts
    │   ├── score-paper.test.ts
    │   ├── extract-claims.test.ts
    │   └── draft-review.test.ts
    ├── trigger/run-review.test.ts
    └── api/
        ├── runs-start.test.ts
        ├── runs-get.test.ts
        └── checkpoint-approve.test.ts
```

**One responsibility per file.** `lib/agent/nodes/*.ts` files are thin — each builds a request via `lib/prompts/*`, calls `runLLM`, persists a `RunStep`, and returns the partial state update. `lib/agent/graph.ts` is the only place that composes nodes into a graph. `trigger/run-review.ts` is the only place that handles `interrupt`-detection-and-resume.

---

## Conventions

- TDD per task.
- Each commit at task end. Conventional prefix.
- Use `runLLM` from `lib/llm.ts` — never call Anthropic SDK directly.
- Use SDK types — no custom interfaces for API shapes.
- No `any`.
- `pnpm tsc --noEmit` and `pnpm test` must pass before commit.
- **Mock all paid APIs** in tests. Mock `@/lib/llm` at the agent-node level; don't mock the Anthropic SDK directly (the existing M2 `lib/llm.test.ts` already covers that).

---

## Task 0: Schema migration — Run / RunStep / HumanCheckpoint / IncludedPaper / ExtractedClaim

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_review_run/migration.sql` (auto-generated)

- [ ] **Step 1: Add five new models and one enum to `prisma/schema.prisma`**

Open `prisma/schema.prisma`. Add a new enum after the existing `CorpusItemStatus` enum:

```prisma
enum RunStatus {
  PENDING
  PLANNING
  AWAITING_PLAN_APPROVAL
  RETRIEVING
  AWAITING_PAPERS_APPROVAL
  ASSESSING
  DRAFTING
  COMPLETED
  REJECTED
  FAILED
}

enum CheckpointKind {
  APPROVE_PLAN
  APPROVE_PAPERS
}

enum CheckpointStatus {
  PENDING
  APPROVED
  REJECTED
}
```

Append five new models to the end of the schema file (after the existing `CorpusItem` model):

```prisma
model Run {
  id              String     @id @default(cuid())
  projectId       String
  project         Project    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  status          RunStatus  @default(PENDING)
  question        String     @db.Text      // snapshot of project.question at run-start
  plan            Json?                    // planner output once approved
  draft           String?    @db.Text      // drafter output (markdown)
  failureReason   String?
  triggerRunId    String?    @unique       // Trigger.dev run id for resume calls
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt
  completedAt     DateTime?

  steps           RunStep[]
  checkpoints     HumanCheckpoint[]
  includedPapers  IncludedPaper[]
  claims          ExtractedClaim[]

  @@index([projectId])
  @@index([status])
}

model RunStep {
  id          String   @id @default(cuid())
  runId       String
  run         Run      @relation(fields: [runId], references: [id], onDelete: Cascade)
  nodeName    String   // "planner" | "retriever" | "assessor" | "drafter"
  startedAt   DateTime @default(now())
  endedAt     DateTime?
  traceUrl    String?
  inputTokens Int      @default(0)
  outputTokens Int     @default(0)
  cacheReadInputTokens Int @default(0)
  failureReason String?

  @@index([runId])
}

model HumanCheckpoint {
  id          String           @id @default(cuid())
  runId       String
  run         Run              @relation(fields: [runId], references: [id], onDelete: Cascade)
  kind        CheckpointKind
  status      CheckpointStatus @default(PENDING)
  proposal    Json             // the data the user is being asked to approve (the plan, or the candidate paper IDs)
  decisionPayload Json?        // user's edits/selections on approval
  rejectionReason String?
  waitToken   String?          @unique    // Trigger.dev wait token; null until task is paused
  createdAt   DateTime         @default(now())
  decidedAt   DateTime?

  @@index([runId])
  @@index([status])
}

model IncludedPaper {
  id           String     @id @default(cuid())
  runId        String
  run          Run        @relation(fields: [runId], references: [id], onDelete: Cascade)
  corpusItemId String
  corpusItem   CorpusItem @relation(fields: [corpusItemId], references: [id], onDelete: Cascade)
  relevanceScore Float    // 0..1
  inclusionReason String  @db.Text
  createdAt    DateTime   @default(now())

  claims       ExtractedClaim[]

  @@unique([runId, corpusItemId])
  @@index([runId])
}

model ExtractedClaim {
  id              String         @id @default(cuid())
  runId           String
  run             Run            @relation(fields: [runId], references: [id], onDelete: Cascade)
  includedPaperId String
  includedPaper   IncludedPaper  @relation(fields: [includedPaperId], references: [id], onDelete: Cascade)
  text            String         @db.Text
  category        String         // "finding" | "methodology" | "limitation" | "context"
  createdAt       DateTime       @default(now())

  @@index([runId])
  @@index([includedPaperId])
}
```

You also need to add a back-relation on existing models. Modify the `Project` model — add this line in the relations block (after `corpus`):

```prisma
  runs        Run[]
```

And modify the `CorpusItem` model — add this line in the relations block (after the existing relations):

```prisma
  includedIn  IncludedPaper[]
```

- [ ] **Step 2: Migrate**

```bash
pnpm prisma migrate dev --name add_review_run
```

Expected: new migration directory + regenerated client at `app/generated/prisma/`.

- [ ] **Step 3: Typecheck**

```bash
pnpm tsc --noEmit
```

Must pass clean.

- [ ] **Step 4: Run existing tests**

```bash
pnpm test
```

Should still be 28 tests passing — no schema-dependent code changes yet.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: schema for runs, steps, checkpoints, included papers, claims"
```

---

## Task 1: Install LangGraph + checkpointer

**Files:**
- Modify: `package.json` (deps)

- [ ] **Step 1: Install**

```bash
pnpm add @langchain/langgraph @langchain/langgraph-checkpoint-postgres
```

- [ ] **Step 2: Verify LangGraph imports work**

```bash
pnpm tsx -e "import('@langchain/langgraph').then(m => console.log(Object.keys(m).filter(k => /StateGraph|Annotation|interrupt|Command/.test(k))))"
```

Expected: prints `[ 'StateGraph', 'Annotation', 'interrupt', 'Command' ]` or similar. If `interrupt` or `Command` is missing, LangGraph's API has shifted — adapt the plan and report in the commit.

- [ ] **Step 3: Verify checkpointer can construct**

```bash
pnpm tsx -e "import('@langchain/langgraph-checkpoint-postgres').then(m => console.log(Object.keys(m).filter(k => /PostgresSaver|fromConnString/.test(k))))"
```

Expected: prints something including `PostgresSaver`.

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm test
pnpm tsc --noEmit
```

Both pass — no source changes yet, just deps.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add langgraph + postgres checkpointer"
```

---

## Task 2: Agent state shape (`lib/agent/state.ts`)

**Files:**
- Create: `lib/agent/state.ts`
- Create: `tests/lib/agent/state.test.ts`

The state shape is the contract every node reads and writes. Get it right here; everything downstream depends on it.

- [ ] **Step 1: Write the failing test**

`tests/lib/agent/state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AgentStateAnnotation, type AgentState } from "@/lib/agent/state";

describe("AgentStateAnnotation", () => {
  it("has all the channels the nodes will read and write", () => {
    const channels = Object.keys(AgentStateAnnotation.spec);
    expect(channels).toEqual(
      expect.arrayContaining([
        "runId",
        "projectId",
        "question",
        "candidateCorpusItems",
        "plan",
        "planApproved",
        "includedPapers",
        "papersApproved",
        "claims",
        "draft",
      ]),
    );
  });

  it("an AgentState object can be constructed with the expected types", () => {
    const s: AgentState = {
      runId: "r1",
      projectId: "p1",
      question: "Does X improve Y?",
      candidateCorpusItems: [
        {
          id: "c1",
          title: "Some paper",
          summary: { abstract: "x", studyType: "empirical", relevanceToSLR: "highly_relevant" },
        },
      ],
      plan: null,
      planApproved: null,
      includedPapers: [],
      papersApproved: null,
      claims: [],
      draft: null,
    };
    expect(s.runId).toBe("r1");
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

```bash
pnpm vitest run tests/lib/agent/state.test.ts
```

- [ ] **Step 3: Implement `lib/agent/state.ts`**

```ts
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
```

- [ ] **Step 4: Re-run, confirm 2/2 pass**

```bash
pnpm vitest run tests/lib/agent/state.test.ts
```

- [ ] **Step 5: Full suite + typecheck**

```bash
pnpm test
pnpm tsc --noEmit
```

Total: 30 tests (28 prior + 2). Tsc clean.

- [ ] **Step 6: Commit**

```bash
git add lib/agent/state.ts tests/lib/agent/state.test.ts
git commit -m "feat: shared agent state shape"
```

---

## Task 3: Planner prompt + node

**Files:**
- Create: `lib/prompts/plan-review.ts`
- Create: `lib/agent/nodes/planner.ts`
- Create: `tests/lib/prompts/plan-review.test.ts`
- Create: `tests/lib/agent/nodes/planner.test.ts`

- [ ] **Step 1: Write the failing prompt test**

`tests/lib/prompts/plan-review.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PlanSchema, buildPlannerRequest } from "@/lib/prompts/plan-review";

describe("PlanSchema", () => {
  it("parses a valid plan", () => {
    const valid = {
      picoc: {
        population: "Software engineers",
        intervention: "Pair programming",
        comparison: "Solo programming",
        outcome: "Code quality",
        context: "Industry",
      },
      subQuestions: ["Does pair programming reduce defects?"],
      inclusionCriteria: ["Empirical study"],
      exclusionCriteria: ["Opinion piece"],
    };
    expect(PlanSchema.parse(valid)).toEqual(valid);
  });

  it("rejects when picoc is missing", () => {
    expect(() => PlanSchema.parse({ subQuestions: [] })).toThrow();
  });
});

describe("buildPlannerRequest", () => {
  it("includes the research question and a system instruction about PICOC", () => {
    const req = buildPlannerRequest({
      question: "Does X improve Y in SE?",
      corpusSize: 12,
    });
    expect(req.system[0].text).toMatch(/PICOC/i);
    expect(JSON.stringify(req.messages[0].content)).toContain("Does X improve Y in SE?");
    expect(JSON.stringify(req.messages[0].content)).toContain("12");
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

```bash
pnpm vitest run tests/lib/prompts/plan-review.test.ts
```

- [ ] **Step 3: Implement `lib/prompts/plan-review.ts`**

```ts
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const PlanSchema = z.object({
  picoc: z.object({
    population: z.string(),
    intervention: z.string(),
    comparison: z.string(),
    outcome: z.string(),
    context: z.string(),
  }),
  subQuestions: z.array(z.string()),
  inclusionCriteria: z.array(z.string()),
  exclusionCriteria: z.array(z.string()),
});

export type Plan = z.infer<typeof PlanSchema>;

const SYSTEM = `You are a research methodologist planning a systematic literature review.

You will receive the user's research question and the number of candidate papers already in their corpus.

Produce a structured plan with:
- A PICOC decomposition (Population, Intervention, Comparison, Outcome, Context)
- 2-5 sub-questions that, when answered together, answer the user's main question
- 3-6 inclusion criteria a paper must meet to be considered
- 2-4 exclusion criteria that disqualify a paper

The plan will be reviewed by the user before any retrieval happens. Be specific and actionable. Avoid generic criteria like "high quality" — anchor to the domain.`;

export function buildPlannerRequest(args: { question: string; corpusSize: number }): {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
} {
  return {
    system: [{ type: "text", text: SYSTEM }],
    messages: [
      {
        role: "user",
        content: `Research question:\n\n> ${args.question}\n\nCorpus size already uploaded: ${args.corpusSize} paper(s).\n\nProduce the structured plan.`,
      },
    ],
  };
}
```

- [ ] **Step 4: Re-run prompt tests, confirm 3/3 pass**

```bash
pnpm vitest run tests/lib/prompts/plan-review.test.ts
```

- [ ] **Step 5: Write the failing planner-node test**

`tests/lib/agent/nodes/planner.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runLLM: vi.fn(),
  addStep: vi.fn(),
  finishStep: vi.fn(),
}));

vi.mock("@/lib/llm", () => ({ runLLM: mocks.runLLM }));
vi.mock("@/lib/agent/runs", () => ({
  addStep: mocks.addStep,
  finishStep: mocks.finishStep,
}));

beforeEach(() => {
  mocks.runLLM.mockReset();
  mocks.addStep.mockResolvedValue({ id: "step_1" });
  mocks.finishStep.mockResolvedValue(undefined);
});

describe("plannerNode", () => {
  it("calls runLLM with the planner request and returns a plan in the state update", async () => {
    mocks.runLLM.mockResolvedValue({
      output: {
        picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
        subQuestions: ["q1"],
        inclusionCriteria: ["ic1"],
        exclusionCriteria: ["ec1"],
      },
      traceUrl: "http://lf/trace_1",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });

    const { plannerNode } = await import("@/lib/agent/nodes/planner");
    const update = await plannerNode({
      runId: "r1",
      projectId: "p1",
      question: "Does X improve Y?",
      candidateCorpusItems: [{ id: "c1", title: "t", summary: null }],
      plan: null,
      planApproved: null,
      includedPapers: [],
      papersApproved: null,
      claims: [],
      draft: null,
    });

    expect(mocks.runLLM).toHaveBeenCalledWith(
      expect.objectContaining({ name: "planner", model: "claude-opus-4-7" }),
    );
    expect(update.plan?.picoc.population).toBe("p");
    expect(mocks.addStep).toHaveBeenCalledWith({ runId: "r1", nodeName: "planner" });
    expect(mocks.finishStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: "step_1",
        traceUrl: "http://lf/trace_1",
        inputTokens: 100,
        outputTokens: 50,
      }),
    );
  });

  it("marks the step as failed on LLM error and rethrows", async () => {
    mocks.runLLM.mockRejectedValue(new Error("anthropic 500"));

    const { plannerNode } = await import("@/lib/agent/nodes/planner");
    await expect(
      plannerNode({
        runId: "r1",
        projectId: "p1",
        question: "?",
        candidateCorpusItems: [],
        plan: null,
        planApproved: null,
        includedPapers: [],
        papersApproved: null,
        claims: [],
        draft: null,
      }),
    ).rejects.toThrow(/anthropic 500/);
    expect(mocks.finishStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: "step_1", failureReason: expect.stringContaining("anthropic 500") }),
    );
  });
});
```

- [ ] **Step 6: Run, confirm FAIL**

```bash
pnpm vitest run tests/lib/agent/nodes/planner.test.ts
```

- [ ] **Step 7: Implement `lib/agent/nodes/planner.ts`**

```ts
import { runLLM } from "@/lib/llm";
import { PlanSchema, buildPlannerRequest } from "@/lib/prompts/plan-review";
import { addStep, finishStep } from "@/lib/agent/runs";
import type { AgentState } from "@/lib/agent/state";

export async function plannerNode(state: AgentState): Promise<Partial<AgentState>> {
  const step = await addStep({ runId: state.runId, nodeName: "planner" });
  try {
    const { system, messages } = buildPlannerRequest({
      question: state.question,
      corpusSize: state.candidateCorpusItems.length,
    });
    const { output, traceUrl, usage } = await runLLM({
      name: "planner",
      model: "claude-opus-4-7",
      maxTokens: 4096,
      system,
      messages,
      schema: PlanSchema,
      metadata: { runId: state.runId, projectId: state.projectId, node: "planner" },
    });
    await finishStep({
      stepId: step.id,
      traceUrl,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
    });
    return { plan: output };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({ stepId: step.id, failureReason: reason.slice(0, 1000) });
    throw err;
  }
}
```

- [ ] **Step 8: Re-run, confirm 2/2 pass**

```bash
pnpm vitest run tests/lib/agent/nodes/planner.test.ts
```

- [ ] **Step 9: Full suite + typecheck**

```bash
pnpm test
pnpm tsc --noEmit
```

Tsc will FAIL because `@/lib/agent/runs` doesn't exist yet. That's fine — Task 4 doesn't depend on it either. Stub `lib/agent/runs.ts` minimally so tsc passes:

`lib/agent/runs.ts`:

```ts
// Real implementation lands in Task 8 (runs DB helpers).
// This stub keeps Tasks 3-7 compilable while we develop nodes against a stable interface.
export async function addStep(_args: { runId: string; nodeName: string }): Promise<{ id: string }> {
  throw new Error("addStep stub — real impl in Task 8");
}
export async function finishStep(_args: {
  stepId: string;
  traceUrl?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  failureReason?: string;
}): Promise<void> {
  throw new Error("finishStep stub — real impl in Task 8");
}
```

Now tsc passes. Tests for the planner node pass because they mock `@/lib/agent/runs`. Real implementation lands in Task 8.

Total tests: 35 (30 + 3 prompts + 2 planner).

- [ ] **Step 10: Commit**

```bash
git add lib/prompts/plan-review.ts lib/agent/nodes/planner.ts lib/agent/runs.ts tests/lib/prompts/plan-review.test.ts tests/lib/agent/nodes/planner.test.ts
git commit -m "feat: planner prompt, schema, and agent node"
```

---

## Task 4: Retriever prompt + node

**Files:**
- Create: `lib/prompts/score-paper.ts`
- Create: `lib/agent/nodes/retriever.ts`
- Create: `tests/lib/prompts/score-paper.test.ts`
- Create: `tests/lib/agent/nodes/retriever.test.ts`

The retriever scores each candidate corpus item against the plan via a per-paper LLM call (no web search in M3 — the corpus is what the user uploaded). Returns top candidates as `IncludedPaperSpec[]`.

- [ ] **Step 1: Write the failing prompt test**

`tests/lib/prompts/score-paper.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PaperScoreSchema, buildPaperScoreRequest } from "@/lib/prompts/score-paper";

describe("PaperScoreSchema", () => {
  it("parses a valid score", () => {
    const valid = { relevanceScore: 0.85, include: true, reason: "Hits PICOC outcome." };
    expect(PaperScoreSchema.parse(valid)).toEqual(valid);
  });

  it("rejects relevanceScore out of range", () => {
    expect(() => PaperScoreSchema.parse({ relevanceScore: 1.5, include: true, reason: "x" })).toThrow();
    expect(() => PaperScoreSchema.parse({ relevanceScore: -0.1, include: false, reason: "x" })).toThrow();
  });
});

describe("buildPaperScoreRequest", () => {
  it("includes the plan, the paper summary, and the user question", () => {
    const req = buildPaperScoreRequest({
      question: "Does X improve Y?",
      plan: {
        picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
        subQuestions: [],
        inclusionCriteria: ["ic1"],
        exclusionCriteria: [],
      },
      paper: { id: "c1", title: "Some paper", summary: { abstract: "About X.", studyType: "empirical", relevanceToSLR: "highly_relevant" } },
    });
    const full = JSON.stringify(req);
    expect(full).toContain("Does X improve Y?");
    expect(full).toContain("ic1");
    expect(full).toContain("About X.");
    expect(full).toContain("Some paper");
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

```bash
pnpm vitest run tests/lib/prompts/score-paper.test.ts
```

- [ ] **Step 3: Implement `lib/prompts/score-paper.ts`**

```ts
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Plan } from "@/lib/prompts/plan-review";
import type { CandidateCorpusItem } from "@/lib/agent/state";

export const PaperScoreSchema = z.object({
  relevanceScore: z.number().min(0).max(1),
  include: z.boolean(),
  reason: z.string(),
});

export type PaperScore = z.infer<typeof PaperScoreSchema>;

const SYSTEM = `You are a research analyst scoring a paper for inclusion in a systematic literature review.

You will receive the user's research question, a structured plan (PICOC, sub-questions, inclusion/exclusion criteria), and a paper summary.

Return a single JSON object:
- relevanceScore: 0-1, how well the paper addresses the user's question and PICOC
- include: true if the paper passes ALL inclusion criteria AND no exclusion criteria, else false
- reason: one sentence explaining the score AND the inclusion decision

Be honest. If the paper is tangential, score it low and exclude it — don't pad the corpus to please the user.`;

export function buildPaperScoreRequest(args: {
  question: string;
  plan: Plan;
  paper: CandidateCorpusItem;
}): {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
} {
  return {
    system: [{ type: "text", text: SYSTEM }],
    messages: [
      {
        role: "user",
        content: `User question: ${args.question}

Plan:
${JSON.stringify(args.plan, null, 2)}

Paper id: ${args.paper.id}
Paper title: ${args.paper.title}
Paper summary:
${JSON.stringify(args.paper.summary, null, 2)}

Score this paper.`,
      },
    ],
  };
}
```

- [ ] **Step 4: Re-run, confirm 3/3 pass**

```bash
pnpm vitest run tests/lib/prompts/score-paper.test.ts
```

- [ ] **Step 5: Write the failing retriever-node test**

`tests/lib/agent/nodes/retriever.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runLLM: vi.fn(),
  addStep: vi.fn(),
  finishStep: vi.fn(),
}));

vi.mock("@/lib/llm", () => ({ runLLM: mocks.runLLM }));
vi.mock("@/lib/agent/runs", () => ({
  addStep: mocks.addStep,
  finishStep: mocks.finishStep,
}));

beforeEach(() => {
  mocks.runLLM.mockReset();
  mocks.addStep.mockResolvedValue({ id: "step_2" });
  mocks.finishStep.mockResolvedValue(undefined);
});

const baseState = {
  runId: "r1",
  projectId: "p1",
  question: "Q?",
  candidateCorpusItems: [
    { id: "c1", title: "P1", summary: null },
    { id: "c2", title: "P2", summary: null },
  ],
  plan: {
    picoc: { population: "", intervention: "", comparison: "", outcome: "", context: "" },
    subQuestions: [],
    inclusionCriteria: [],
    exclusionCriteria: [],
  },
  planApproved: { approved: true },
  includedPapers: [],
  papersApproved: null,
  claims: [],
  draft: null,
};

describe("retrieverNode", () => {
  it("scores each candidate and returns only included papers", async () => {
    mocks.runLLM
      .mockResolvedValueOnce({
        output: { relevanceScore: 0.9, include: true, reason: "Hits PICOC." },
        traceUrl: "tu1",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      })
      .mockResolvedValueOnce({
        output: { relevanceScore: 0.2, include: false, reason: "Off topic." },
        traceUrl: "tu2",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      });

    const { retrieverNode } = await import("@/lib/agent/nodes/retriever");
    const update = await retrieverNode(baseState);

    expect(mocks.runLLM).toHaveBeenCalledTimes(2);
    expect(update.includedPapers).toHaveLength(1);
    expect(update.includedPapers?.[0]?.corpusItemId).toBe("c1");
    expect(update.includedPapers?.[0]?.relevanceScore).toBe(0.9);
  });

  it("returns empty includedPapers if every candidate is excluded", async () => {
    mocks.runLLM.mockResolvedValue({
      output: { relevanceScore: 0.1, include: false, reason: "Off topic." },
      traceUrl: "tu",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });

    const { retrieverNode } = await import("@/lib/agent/nodes/retriever");
    const update = await retrieverNode(baseState);

    expect(update.includedPapers).toEqual([]);
  });

  it("throws when state.plan is null (planner hasn't run)", async () => {
    const { retrieverNode } = await import("@/lib/agent/nodes/retriever");
    await expect(retrieverNode({ ...baseState, plan: null })).rejects.toThrow(/plan/i);
  });
});
```

- [ ] **Step 6: Run, confirm FAIL**

```bash
pnpm vitest run tests/lib/agent/nodes/retriever.test.ts
```

- [ ] **Step 7: Implement `lib/agent/nodes/retriever.ts`**

```ts
import { runLLM } from "@/lib/llm";
import { PaperScoreSchema, buildPaperScoreRequest } from "@/lib/prompts/score-paper";
import { addStep, finishStep } from "@/lib/agent/runs";
import type { AgentState, IncludedPaperSpec } from "@/lib/agent/state";

export async function retrieverNode(state: AgentState): Promise<Partial<AgentState>> {
  if (!state.plan) throw new Error("retriever: state.plan is null — planner must run first");

  const step = await addStep({ runId: state.runId, nodeName: "retriever" });
  let totalIn = 0, totalOut = 0, totalCacheRead = 0;
  const traces: string[] = [];

  try {
    const included: IncludedPaperSpec[] = [];
    for (const paper of state.candidateCorpusItems) {
      const { system, messages } = buildPaperScoreRequest({
        question: state.question,
        plan: state.plan,
        paper,
      });
      const { output, traceUrl, usage } = await runLLM({
        name: "retriever:score",
        model: "claude-sonnet-4-6", // cheaper scoring per spec stack-routing
        maxTokens: 1024,
        system,
        messages,
        schema: PaperScoreSchema,
        metadata: { runId: state.runId, projectId: state.projectId, node: "retriever", corpusItemId: paper.id },
      });
      totalIn += usage.inputTokens;
      totalOut += usage.outputTokens;
      totalCacheRead += usage.cacheReadInputTokens;
      traces.push(traceUrl);

      if (output.include) {
        included.push({
          corpusItemId: paper.id,
          relevanceScore: output.relevanceScore,
          inclusionReason: output.reason,
        });
      }
    }

    await finishStep({
      stepId: step.id,
      // Report the first trace URL on the step row for the UI deep-link (M4 will surface all).
      traceUrl: traces[0],
      inputTokens: totalIn,
      outputTokens: totalOut,
      cacheReadInputTokens: totalCacheRead,
    });

    return { includedPapers: included };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({ stepId: step.id, failureReason: reason.slice(0, 1000) });
    throw err;
  }
}
```

- [ ] **Step 8: Re-run, confirm 3/3 pass**

```bash
pnpm vitest run tests/lib/agent/nodes/retriever.test.ts
```

- [ ] **Step 9: Full suite + typecheck**

```bash
pnpm test
pnpm tsc --noEmit
```

Total tests: 41 (35 + 3 prompt + 3 node).

- [ ] **Step 10: Commit**

```bash
git add lib/prompts/score-paper.ts lib/agent/nodes/retriever.ts tests/lib/prompts/score-paper.test.ts tests/lib/agent/nodes/retriever.test.ts
git commit -m "feat: retriever prompt and per-paper-scoring agent node"
```

---

## Task 5: Assessor prompt + node

**Files:**
- Create: `lib/prompts/extract-claims.ts`
- Create: `lib/agent/nodes/assessor.ts`
- Create: `tests/lib/prompts/extract-claims.test.ts`
- Create: `tests/lib/agent/nodes/assessor.test.ts`

The assessor reads each approved paper's full markdown and extracts a list of categorised claims. One LLM call per included paper. Output: `ClaimSpec[]` aggregated across papers.

- [ ] **Step 1: Write the failing prompt test**

`tests/lib/prompts/extract-claims.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ClaimsSchema, buildExtractClaimsRequest } from "@/lib/prompts/extract-claims";

describe("ClaimsSchema", () => {
  it("parses a list of categorised claims", () => {
    const valid = {
      claims: [
        { text: "Pair programming reduced defects by 15%.", category: "finding" },
        { text: "Sample was 200 industry developers.", category: "methodology" },
      ],
    };
    expect(ClaimsSchema.parse(valid)).toEqual(valid);
  });

  it("rejects unknown category", () => {
    expect(() =>
      ClaimsSchema.parse({ claims: [{ text: "x", category: "weird" }] }),
    ).toThrow();
  });
});

describe("buildExtractClaimsRequest", () => {
  it("caches the paper markdown and references the user question", () => {
    const req = buildExtractClaimsRequest({
      question: "Does pair programming help?",
      paperMarkdown: "# Title\n\nBody.",
    });
    expect(req.system).toHaveLength(2);
    expect(req.system[0].text).toMatch(/extract/i);
    expect(req.system[1].text).toContain("# Title");
    expect(req.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(req.messages[0].content)).toContain("Does pair programming help?");
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

```bash
pnpm vitest run tests/lib/prompts/extract-claims.test.ts
```

- [ ] **Step 3: Implement `lib/prompts/extract-claims.ts`**

```ts
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const ClaimsSchema = z.object({
  claims: z.array(
    z.object({
      text: z.string(),
      category: z.enum(["finding", "methodology", "limitation", "context"]),
    }),
  ),
});

export type Claims = z.infer<typeof ClaimsSchema>;

const SYSTEM = `You are a research analyst extracting structured claims from a paper for a systematic literature review.

Read the paper in the next system block and return a list of claims, each tagged with one category:
- "finding" — a result or conclusion the paper supports (preferably with numbers)
- "methodology" — a key design decision (sample, instrument, analysis approach)
- "limitation" — a constraint on validity or generalisability
- "context" — domain or setting facts useful for synthesis

Aim for 5-15 claims per paper. Be specific. Quote numbers and effect sizes when the paper does. Do NOT include claims the paper does not support.`;

export function buildExtractClaimsRequest(args: {
  question: string;
  paperMarkdown: string;
}): {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
} {
  return {
    system: [
      { type: "text", text: SYSTEM },
      {
        type: "text",
        text: `<paper>\n${args.paperMarkdown}\n</paper>`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `The user's research question is:\n\n> ${args.question}\n\nExtract claims from the paper above that are relevant to this question.`,
      },
    ],
  };
}
```

- [ ] **Step 4: Re-run, confirm 3/3 pass**

```bash
pnpm vitest run tests/lib/prompts/extract-claims.test.ts
```

- [ ] **Step 5: Write the failing assessor-node test**

`tests/lib/agent/nodes/assessor.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runLLM: vi.fn(),
  addStep: vi.fn(),
  finishStep: vi.fn(),
  findCorpusMarkdown: vi.fn(),
}));

vi.mock("@/lib/llm", () => ({ runLLM: mocks.runLLM }));
vi.mock("@/lib/agent/runs", () => ({
  addStep: mocks.addStep,
  finishStep: mocks.finishStep,
  findCorpusMarkdown: mocks.findCorpusMarkdown,
}));

beforeEach(() => {
  mocks.runLLM.mockReset();
  mocks.addStep.mockResolvedValue({ id: "step_3" });
  mocks.finishStep.mockResolvedValue(undefined);
  mocks.findCorpusMarkdown.mockReset();
});

const baseState = {
  runId: "r1",
  projectId: "p1",
  question: "Q?",
  candidateCorpusItems: [],
  plan: {
    picoc: { population: "", intervention: "", comparison: "", outcome: "", context: "" },
    subQuestions: [],
    inclusionCriteria: [],
    exclusionCriteria: [],
  },
  planApproved: { approved: true },
  includedPapers: [
    { corpusItemId: "c1", relevanceScore: 0.9, inclusionReason: "x" },
    { corpusItemId: "c2", relevanceScore: 0.8, inclusionReason: "y" },
  ],
  papersApproved: { approved: true, corpusItemIds: ["c1", "c2"] },
  claims: [],
  draft: null,
};

describe("assessorNode", () => {
  it("extracts claims from each approved paper and aggregates them", async () => {
    mocks.findCorpusMarkdown.mockImplementation(async (id: string) => `# Paper ${id}`);
    mocks.runLLM
      .mockResolvedValueOnce({
        output: { claims: [{ text: "Finding 1", category: "finding" }] },
        traceUrl: "tu1",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      })
      .mockResolvedValueOnce({
        output: { claims: [{ text: "Method 1", category: "methodology" }] },
        traceUrl: "tu2",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      });

    const { assessorNode } = await import("@/lib/agent/nodes/assessor");
    const update = await assessorNode(baseState);

    expect(update.claims).toHaveLength(2);
    expect(update.claims?.[0]?.includedPaperId).toBe("c1");
    expect(update.claims?.[0]?.text).toBe("Finding 1");
    expect(update.claims?.[1]?.includedPaperId).toBe("c2");
  });

  it("skips a paper that has no parsed markdown but continues with others", async () => {
    mocks.findCorpusMarkdown
      .mockResolvedValueOnce(null)         // c1 missing markdown
      .mockResolvedValueOnce("# Paper c2"); // c2 has it
    mocks.runLLM.mockResolvedValue({
      output: { claims: [{ text: "ok", category: "finding" }] },
      traceUrl: "tu",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });

    const { assessorNode } = await import("@/lib/agent/nodes/assessor");
    const update = await assessorNode(baseState);

    expect(mocks.runLLM).toHaveBeenCalledTimes(1);
    expect(update.claims?.[0]?.includedPaperId).toBe("c2");
  });
});
```

- [ ] **Step 6: Run, confirm FAIL**

```bash
pnpm vitest run tests/lib/agent/nodes/assessor.test.ts
```

- [ ] **Step 7: Implement `lib/agent/nodes/assessor.ts`**

```ts
import { runLLM } from "@/lib/llm";
import { ClaimsSchema, buildExtractClaimsRequest } from "@/lib/prompts/extract-claims";
import { addStep, finishStep, findCorpusMarkdown } from "@/lib/agent/runs";
import type { AgentState, ClaimSpec } from "@/lib/agent/state";

export async function assessorNode(state: AgentState): Promise<Partial<AgentState>> {
  const step = await addStep({ runId: state.runId, nodeName: "assessor" });
  let totalIn = 0, totalOut = 0, totalCacheRead = 0;
  const firstTraceUrl: { value?: string } = {};
  const claims: ClaimSpec[] = [];

  try {
    for (const inc of state.includedPapers) {
      const markdown = await findCorpusMarkdown(inc.corpusItemId);
      if (!markdown) continue;

      const { system, messages } = buildExtractClaimsRequest({
        question: state.question,
        paperMarkdown: markdown,
      });
      const { output, traceUrl, usage } = await runLLM({
        name: "assessor:extract",
        model: "claude-sonnet-4-6",
        maxTokens: 4096,
        system,
        messages,
        schema: ClaimsSchema,
        metadata: { runId: state.runId, projectId: state.projectId, node: "assessor", corpusItemId: inc.corpusItemId },
      });

      totalIn += usage.inputTokens;
      totalOut += usage.outputTokens;
      totalCacheRead += usage.cacheReadInputTokens;
      firstTraceUrl.value ??= traceUrl;

      for (const c of output.claims) {
        claims.push({
          includedPaperId: inc.corpusItemId,
          text: c.text,
          category: c.category,
        });
      }
    }

    await finishStep({
      stepId: step.id,
      traceUrl: firstTraceUrl.value,
      inputTokens: totalIn,
      outputTokens: totalOut,
      cacheReadInputTokens: totalCacheRead,
    });
    return { claims };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({ stepId: step.id, failureReason: reason.slice(0, 1000) });
    throw err;
  }
}
```

Note: the `includedPaperId` here is the `corpusItemId` (we conflate them in agent state for simplicity — the real DB `IncludedPaper.id` is resolved at persist time in Task 8).

- [ ] **Step 8: Extend `lib/agent/runs.ts` stub**

Open `lib/agent/runs.ts` and add (keep existing `addStep`/`finishStep` stubs):

```ts
export async function findCorpusMarkdown(_corpusItemId: string): Promise<string | null> {
  throw new Error("findCorpusMarkdown stub — real impl in Task 8");
}
```

- [ ] **Step 9: Re-run, confirm 2/2 pass**

```bash
pnpm vitest run tests/lib/agent/nodes/assessor.test.ts
```

- [ ] **Step 10: Full suite + typecheck**

```bash
pnpm test
pnpm tsc --noEmit
```

Total tests: 46 (41 + 3 prompt + 2 node).

- [ ] **Step 11: Commit**

```bash
git add lib/prompts/extract-claims.ts lib/agent/nodes/assessor.ts lib/agent/runs.ts tests/lib/prompts/extract-claims.test.ts tests/lib/agent/nodes/assessor.test.ts
git commit -m "feat: assessor prompt and claim-extraction agent node"
```

---

## Task 6: Drafter prompt + node

**Files:**
- Create: `lib/prompts/draft-review.ts`
- Create: `lib/agent/nodes/drafter.ts`
- Create: `tests/lib/prompts/draft-review.test.ts`
- Create: `tests/lib/agent/nodes/drafter.test.ts`

The drafter composes the final review as markdown with inline `[paper_id]` citations.

- [ ] **Step 1: Write the failing prompt test**

`tests/lib/prompts/draft-review.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DraftSchema, buildDrafterRequest } from "@/lib/prompts/draft-review";

describe("DraftSchema", () => {
  it("parses a markdown draft", () => {
    expect(DraftSchema.parse({ draft: "# Title\n\nBody [c1]." })).toEqual({ draft: "# Title\n\nBody [c1]." });
  });

  it("rejects empty draft", () => {
    expect(() => DraftSchema.parse({ draft: "" })).toThrow();
  });
});

describe("buildDrafterRequest", () => {
  it("includes the plan, claims, and citation guidance", () => {
    const req = buildDrafterRequest({
      question: "Does X improve Y?",
      plan: {
        picoc: { population: "", intervention: "", comparison: "", outcome: "", context: "" },
        subQuestions: [],
        inclusionCriteria: [],
        exclusionCriteria: [],
      },
      claims: [{ includedPaperId: "c1", text: "X improves Y by 20%", category: "finding" }],
    });
    expect(req.system[0].text).toMatch(/\[paper_id\]/);
    const userText = JSON.stringify(req.messages[0].content);
    expect(userText).toContain("X improves Y by 20%");
    expect(userText).toContain("c1");
    expect(userText).toContain("Does X improve Y?");
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

```bash
pnpm vitest run tests/lib/prompts/draft-review.test.ts
```

- [ ] **Step 3: Implement `lib/prompts/draft-review.ts`**

```ts
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Plan } from "@/lib/prompts/plan-review";
import type { ClaimSpec } from "@/lib/agent/state";

export const DraftSchema = z.object({
  draft: z.string().min(1),
});

export type Draft = z.infer<typeof DraftSchema>;

const SYSTEM = `You are a research writer composing a systematic literature review section from a curated set of claims.

Format:
- Markdown
- Use H2 (##) section headings keyed to the plan's sub-questions, plus an Introduction and a Discussion
- Cite each claim with [paper_id] inline, where paper_id is the corpus item id provided
- A claim must be cited where it appears. Multiple citations: [c1] [c4] (space-separated)
- If a finding is contested across papers, present both views with citations to each
- Do NOT cite a paper id you were not given. Do NOT invent claims that aren't in the input list.
- Length: 600-1500 words.`;

export function buildDrafterRequest(args: {
  question: string;
  plan: Plan;
  claims: ClaimSpec[];
}): {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
} {
  const claimsLines = args.claims
    .map((c) => `- [${c.includedPaperId}] (${c.category}) ${c.text}`)
    .join("\n");

  return {
    system: [{ type: "text", text: SYSTEM }],
    messages: [
      {
        role: "user",
        content: `Research question:\n\n> ${args.question}\n\nPlan:\n${JSON.stringify(args.plan, null, 2)}\n\nClaims (each prefixed with its source paper id):\n${claimsLines}\n\nWrite the review.`,
      },
    ],
  };
}
```

- [ ] **Step 4: Re-run, confirm 3/3 pass**

```bash
pnpm vitest run tests/lib/prompts/draft-review.test.ts
```

- [ ] **Step 5: Write the failing drafter-node test**

`tests/lib/agent/nodes/drafter.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runLLM: vi.fn(),
  addStep: vi.fn(),
  finishStep: vi.fn(),
}));

vi.mock("@/lib/llm", () => ({ runLLM: mocks.runLLM }));
vi.mock("@/lib/agent/runs", () => ({
  addStep: mocks.addStep,
  finishStep: mocks.finishStep,
}));

beforeEach(() => {
  mocks.runLLM.mockReset();
  mocks.addStep.mockResolvedValue({ id: "step_4" });
  mocks.finishStep.mockResolvedValue(undefined);
});

const baseState = {
  runId: "r1",
  projectId: "p1",
  question: "Q?",
  candidateCorpusItems: [],
  plan: {
    picoc: { population: "", intervention: "", comparison: "", outcome: "", context: "" },
    subQuestions: ["q1"],
    inclusionCriteria: [],
    exclusionCriteria: [],
  },
  planApproved: { approved: true },
  includedPapers: [{ corpusItemId: "c1", relevanceScore: 0.9, inclusionReason: "x" }],
  papersApproved: { approved: true, corpusItemIds: ["c1"] },
  claims: [{ includedPaperId: "c1", text: "X improves Y.", category: "finding" as const }],
  draft: null,
};

describe("drafterNode", () => {
  it("calls runLLM and returns the draft in the state update", async () => {
    mocks.runLLM.mockResolvedValue({
      output: { draft: "# Review\n\nFinding [c1]." },
      traceUrl: "tu",
      usage: { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });

    const { drafterNode } = await import("@/lib/agent/nodes/drafter");
    const update = await drafterNode(baseState);

    expect(update.draft).toContain("[c1]");
    expect(mocks.runLLM).toHaveBeenCalledWith(
      expect.objectContaining({ name: "drafter", model: "claude-opus-4-7" }),
    );
  });

  it("throws when state.claims is empty (nothing to draft from)", async () => {
    const { drafterNode } = await import("@/lib/agent/nodes/drafter");
    await expect(drafterNode({ ...baseState, claims: [] })).rejects.toThrow(/no claims/i);
  });
});
```

- [ ] **Step 6: Run, confirm FAIL**

```bash
pnpm vitest run tests/lib/agent/nodes/drafter.test.ts
```

- [ ] **Step 7: Implement `lib/agent/nodes/drafter.ts`**

```ts
import { runLLM } from "@/lib/llm";
import { DraftSchema, buildDrafterRequest } from "@/lib/prompts/draft-review";
import { addStep, finishStep } from "@/lib/agent/runs";
import type { AgentState } from "@/lib/agent/state";

export async function drafterNode(state: AgentState): Promise<Partial<AgentState>> {
  if (!state.plan) throw new Error("drafter: state.plan is null");
  if (state.claims.length === 0) throw new Error("drafter: no claims to draft from");

  const step = await addStep({ runId: state.runId, nodeName: "drafter" });
  try {
    const { system, messages } = buildDrafterRequest({
      question: state.question,
      plan: state.plan,
      claims: state.claims,
    });
    const { output, traceUrl, usage } = await runLLM({
      name: "drafter",
      model: "claude-opus-4-7",
      maxTokens: 16000,
      system,
      messages,
      schema: DraftSchema,
      metadata: { runId: state.runId, projectId: state.projectId, node: "drafter" },
    });
    await finishStep({
      stepId: step.id,
      traceUrl,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
    });
    return { draft: output.draft };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({ stepId: step.id, failureReason: reason.slice(0, 1000) });
    throw err;
  }
}
```

- [ ] **Step 8: Re-run, confirm 2/2 pass**

```bash
pnpm vitest run tests/lib/agent/nodes/drafter.test.ts
```

- [ ] **Step 9: Full suite + typecheck**

```bash
pnpm test
pnpm tsc --noEmit
```

Total tests: 51 (46 + 3 prompt + 2 node).

- [ ] **Step 10: Commit**

```bash
git add lib/prompts/draft-review.ts lib/agent/nodes/drafter.ts tests/lib/prompts/draft-review.test.ts tests/lib/agent/nodes/drafter.test.ts
git commit -m "feat: drafter prompt and review-composition agent node"
```

---

## Task 7: Graph composition + HITL interrupts

**Files:**
- Create: `lib/agent/checkpointer.ts`
- Create: `lib/agent/graph.ts`
- Create: `tests/lib/agent/graph.test.ts`

The graph wires the four nodes together with conditional edges that drive the two HITL gates via `interrupt()`. Tests exercise the full traversal with all four nodes mocked.

- [ ] **Step 1: Implement `lib/agent/checkpointer.ts`**

```ts
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { env } from "@/lib/env";

let _saver: PostgresSaver | null = null;
let _setupDone = false;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (_saver && _setupDone) return _saver;
  _saver = PostgresSaver.fromConnString(env.DATABASE_URL);
  await _saver.setup();
  _setupDone = true;
  return _saver;
}

export function _resetCheckpointerForTest(): void {
  _saver = null;
  _setupDone = false;
}
```

- [ ] **Step 2: Write the failing graph test**

`tests/lib/agent/graph.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  planner: vi.fn(),
  retriever: vi.fn(),
  assessor: vi.fn(),
  drafter: vi.fn(),
}));

vi.mock("@/lib/agent/nodes/planner", () => ({ plannerNode: mocks.planner }));
vi.mock("@/lib/agent/nodes/retriever", () => ({ retrieverNode: mocks.retriever }));
vi.mock("@/lib/agent/nodes/assessor", () => ({ assessorNode: mocks.assessor }));
vi.mock("@/lib/agent/nodes/drafter", () => ({ drafterNode: mocks.drafter }));

// Avoid touching real postgres in tests — use an in-memory checkpointer.
vi.mock("@/lib/agent/checkpointer", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  const saver = new MemorySaver();
  return { getCheckpointer: async () => saver, _resetCheckpointerForTest: () => {} };
});

beforeEach(() => {
  mocks.planner.mockReset();
  mocks.retriever.mockReset();
  mocks.assessor.mockReset();
  mocks.drafter.mockReset();
});

const initialState = {
  runId: "r1",
  projectId: "p1",
  question: "Q?",
  candidateCorpusItems: [{ id: "c1", title: "P1", summary: null }],
  plan: null,
  planApproved: null,
  includedPapers: [],
  papersApproved: null,
  claims: [],
  draft: null,
};

describe("agent graph", () => {
  it("pauses after planner with the plan ready for HITL approval", async () => {
    mocks.planner.mockResolvedValue({
      plan: {
        picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
        subQuestions: [],
        inclusionCriteria: [],
        exclusionCriteria: [],
      },
    });

    const { buildGraph } = await import("@/lib/agent/graph");
    const graph = await buildGraph();

    const config = { configurable: { thread_id: "r1" } };
    const result = await graph.invoke(initialState, config);

    // Expect graph to have run planner then hit an interrupt
    expect(mocks.planner).toHaveBeenCalledTimes(1);
    expect(mocks.retriever).not.toHaveBeenCalled();

    // After interrupt, graph state should still have the plan but no approval yet
    const snapshot = await graph.getState(config);
    expect(snapshot.values.plan).toBeTruthy();
    expect(snapshot.values.planApproved).toBeNull();
    // tasks pending means an interrupt is active
    expect(snapshot.tasks.length).toBeGreaterThan(0);
  });

  it("runs to completion when both HITL gates are auto-approved via Command.resume", async () => {
    mocks.planner.mockResolvedValue({
      plan: {
        picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
        subQuestions: ["q1"],
        inclusionCriteria: [],
        exclusionCriteria: [],
      },
    });
    mocks.retriever.mockResolvedValue({
      includedPapers: [{ corpusItemId: "c1", relevanceScore: 0.9, inclusionReason: "r" }],
    });
    mocks.assessor.mockResolvedValue({
      claims: [{ includedPaperId: "c1", text: "Finding", category: "finding" }],
    });
    mocks.drafter.mockResolvedValue({ draft: "# Review\n\nFinding [c1]." });

    const { buildGraph } = await import("@/lib/agent/graph");
    const { Command } = await import("@langchain/langgraph");
    const graph = await buildGraph();

    const config = { configurable: { thread_id: "r2" } };
    // First leg: planner → interrupt
    await graph.invoke({ ...initialState, runId: "r2" }, config);
    // Resume with plan approval
    await graph.invoke(new Command({ resume: { approved: true } }), config);
    // Resume with papers approval
    await graph.invoke(new Command({ resume: { approved: true, corpusItemIds: ["c1"] } }), config);

    const final = await graph.getState(config);
    expect(final.values.draft).toContain("[c1]");
    expect(mocks.drafter).toHaveBeenCalledTimes(1);
  });

  it("skips retriever/assessor/drafter when plan is rejected", async () => {
    mocks.planner.mockResolvedValue({
      plan: {
        picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
        subQuestions: [],
        inclusionCriteria: [],
        exclusionCriteria: [],
      },
    });

    const { buildGraph } = await import("@/lib/agent/graph");
    const { Command } = await import("@langchain/langgraph");
    const graph = await buildGraph();

    const config = { configurable: { thread_id: "r3" } };
    await graph.invoke({ ...initialState, runId: "r3" }, config);
    await graph.invoke(
      new Command({ resume: { approved: false, rejectionReason: "Out of scope" } }),
      config,
    );

    const final = await graph.getState(config);
    expect(mocks.retriever).not.toHaveBeenCalled();
    expect(mocks.assessor).not.toHaveBeenCalled();
    expect(mocks.drafter).not.toHaveBeenCalled();
    expect(final.values.planApproved?.approved).toBe(false);
  });
});
```

- [ ] **Step 3: Run, confirm FAIL**

```bash
pnpm vitest run tests/lib/agent/graph.test.ts
```

- [ ] **Step 4: Implement `lib/agent/graph.ts`**

```ts
import { StateGraph, START, END, interrupt } from "@langchain/langgraph";
import { AgentStateAnnotation, type AgentState } from "@/lib/agent/state";
import { plannerNode } from "@/lib/agent/nodes/planner";
import { retrieverNode } from "@/lib/agent/nodes/retriever";
import { assessorNode } from "@/lib/agent/nodes/assessor";
import { drafterNode } from "@/lib/agent/nodes/drafter";
import { getCheckpointer } from "@/lib/agent/checkpointer";

/** HITL gate node: pauses the graph until a `Command.resume(...)` arrives with the user's decision. */
function planApprovalGate(state: AgentState): Partial<AgentState> {
  const decision = interrupt({
    kind: "APPROVE_PLAN",
    plan: state.plan,
  });
  return { planApproved: decision as AgentState["planApproved"] };
}

function papersApprovalGate(state: AgentState): Partial<AgentState> {
  const decision = interrupt({
    kind: "APPROVE_PAPERS",
    includedPapers: state.includedPapers,
  });
  return { papersApproved: decision as AgentState["papersApproved"] };
}

function routeAfterPlanGate(state: AgentState): "retriever" | typeof END {
  return state.planApproved?.approved ? "retriever" : END;
}

function routeAfterPapersGate(state: AgentState): "assessor" | typeof END {
  return state.papersApproved?.approved ? "assessor" : END;
}

export async function buildGraph() {
  const checkpointer = await getCheckpointer();
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode("planner", plannerNode)
    .addNode("plan_gate", planApprovalGate)
    .addNode("retriever", retrieverNode)
    .addNode("papers_gate", papersApprovalGate)
    .addNode("assessor", assessorNode)
    .addNode("drafter", drafterNode)
    .addEdge(START, "planner")
    .addEdge("planner", "plan_gate")
    .addConditionalEdges("plan_gate", routeAfterPlanGate, { retriever: "retriever", [END]: END })
    .addEdge("retriever", "papers_gate")
    .addConditionalEdges("papers_gate", routeAfterPapersGate, { assessor: "assessor", [END]: END })
    .addEdge("assessor", "drafter")
    .addEdge("drafter", END);
  return graph.compile({ checkpointer });
}
```

- [ ] **Step 5: Re-run, confirm 3/3 pass**

```bash
pnpm vitest run tests/lib/agent/graph.test.ts
```

If LangGraph's API has shifted (e.g., `interrupt` signature, `Command.resume` shape, `addConditionalEdges` argument order), adapt the impl AND the test together. Report any deviations.

- [ ] **Step 6: Full suite + typecheck**

```bash
pnpm test
pnpm tsc --noEmit
```

Total tests: 54 (51 + 3 graph).

- [ ] **Step 7: Commit**

```bash
git add lib/agent/checkpointer.ts lib/agent/graph.ts tests/lib/agent/graph.test.ts
git commit -m "feat: agent graph with HITL gates via interrupt()"
```

---

## Task 8: Runs DB helpers (replace the stubs)

**Files:**
- Modify: `lib/agent/runs.ts` (replace stubs with real Prisma)
- Create: `tests/lib/agent/runs.test.ts`

The agent nodes call `addStep`, `finishStep`, `findCorpusMarkdown`. Plus we need helpers the API and Trigger.dev task will use: `createRun`, `recordCheckpoint`, `resolveCheckpoint`, `persistIncludedPapers`, `persistClaims`, `finishRun`, `failRun`.

- [ ] **Step 1: Write the failing test**

`tests/lib/agent/runs.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    run: {
      create: vi.fn(),
      update: vi.fn(),
    },
    runStep: {
      create: vi.fn(),
      update: vi.fn(),
    },
    humanCheckpoint: {
      create: vi.fn(),
      update: vi.fn(),
    },
    includedPaper: {
      createMany: vi.fn(),
      findMany: vi.fn(),
    },
    extractedClaim: {
      createMany: vi.fn(),
    },
    corpusItem: {
      findUnique: vi.fn(),
    },
  },
}));

import { db } from "@/lib/db";

beforeEach(() => vi.clearAllMocks());

describe("runs helpers", () => {
  it("createRun creates a row with PENDING status", async () => {
    vi.mocked(db.run.create).mockResolvedValue({ id: "r1" } as never);
    const { createRun } = await import("@/lib/agent/runs");
    const r = await createRun({ projectId: "p1", question: "Q?" });
    expect(r.id).toBe("r1");
    expect(db.run.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ projectId: "p1", question: "Q?", status: "PENDING" }) }),
    );
  });

  it("addStep returns the created step id", async () => {
    vi.mocked(db.runStep.create).mockResolvedValue({ id: "step_1" } as never);
    const { addStep } = await import("@/lib/agent/runs");
    const s = await addStep({ runId: "r1", nodeName: "planner" });
    expect(s.id).toBe("step_1");
  });

  it("finishStep updates the row with token usage and trace url", async () => {
    const { finishStep } = await import("@/lib/agent/runs");
    await finishStep({
      stepId: "step_1",
      traceUrl: "http://lf/x",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 80,
    });
    expect(db.runStep.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "step_1" },
        data: expect.objectContaining({
          traceUrl: "http://lf/x",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 80,
          endedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("findCorpusMarkdown returns parsedMarkdown when PARSED", async () => {
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue({
      id: "c1",
      status: "PARSED",
      parsedMarkdown: "# Paper",
    } as never);
    const { findCorpusMarkdown } = await import("@/lib/agent/runs");
    expect(await findCorpusMarkdown("c1")).toBe("# Paper");
  });

  it("findCorpusMarkdown returns null when not PARSED", async () => {
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue({
      id: "c1",
      status: "PARSING",
      parsedMarkdown: null,
    } as never);
    const { findCorpusMarkdown } = await import("@/lib/agent/runs");
    expect(await findCorpusMarkdown("c1")).toBeNull();
  });

  it("recordCheckpoint persists a PENDING checkpoint with the proposal payload", async () => {
    vi.mocked(db.humanCheckpoint.create).mockResolvedValue({ id: "cp_1" } as never);
    const { recordCheckpoint } = await import("@/lib/agent/runs");
    const cp = await recordCheckpoint({
      runId: "r1",
      kind: "APPROVE_PLAN",
      proposal: { picoc: {} } as never,
      waitToken: "tk_abc",
    });
    expect(cp.id).toBe("cp_1");
    expect(db.humanCheckpoint.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runId: "r1",
          kind: "APPROVE_PLAN",
          status: "PENDING",
          waitToken: "tk_abc",
        }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

```bash
pnpm vitest run tests/lib/agent/runs.test.ts
```

Existing planner/retriever/assessor tests should still pass (they mock `@/lib/agent/runs`).

- [ ] **Step 3: Replace `lib/agent/runs.ts` with the real implementation**

```ts
import { db } from "@/lib/db";
import type { Prisma } from "@/app/generated/prisma/client";
import type { IncludedPaperSpec, ClaimSpec } from "@/lib/agent/state";

export async function createRun(args: { projectId: string; question: string }): Promise<{ id: string }> {
  const r = await db.run.create({
    data: { projectId: args.projectId, question: args.question, status: "PENDING" },
    select: { id: true },
  });
  return r;
}

export async function setRunStatus(args: {
  runId: string;
  status:
    | "PENDING"
    | "PLANNING"
    | "AWAITING_PLAN_APPROVAL"
    | "RETRIEVING"
    | "AWAITING_PAPERS_APPROVAL"
    | "ASSESSING"
    | "DRAFTING"
    | "COMPLETED"
    | "REJECTED"
    | "FAILED";
  triggerRunId?: string;
}): Promise<void> {
  await db.run.update({
    where: { id: args.runId },
    data: { status: args.status, ...(args.triggerRunId ? { triggerRunId: args.triggerRunId } : {}) },
  });
}

export async function addStep(args: { runId: string; nodeName: string }): Promise<{ id: string }> {
  return db.runStep.create({
    data: { runId: args.runId, nodeName: args.nodeName },
    select: { id: true },
  });
}

export async function finishStep(args: {
  stepId: string;
  traceUrl?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  failureReason?: string;
}): Promise<void> {
  await db.runStep.update({
    where: { id: args.stepId },
    data: {
      endedAt: new Date(),
      traceUrl: args.traceUrl ?? null,
      inputTokens: args.inputTokens ?? 0,
      outputTokens: args.outputTokens ?? 0,
      cacheReadInputTokens: args.cacheReadInputTokens ?? 0,
      failureReason: args.failureReason ?? null,
    },
  });
}

export async function findCorpusMarkdown(corpusItemId: string): Promise<string | null> {
  const ci = await db.corpusItem.findUnique({
    where: { id: corpusItemId },
    select: { status: true, parsedMarkdown: true },
  });
  if (!ci || ci.status !== "PARSED") return null;
  return ci.parsedMarkdown;
}

export async function recordCheckpoint(args: {
  runId: string;
  kind: "APPROVE_PLAN" | "APPROVE_PAPERS";
  proposal: Prisma.InputJsonValue;
  waitToken: string;
}): Promise<{ id: string }> {
  return db.humanCheckpoint.create({
    data: {
      runId: args.runId,
      kind: args.kind,
      proposal: args.proposal,
      waitToken: args.waitToken,
      status: "PENDING",
    },
    select: { id: true },
  });
}

export async function resolveCheckpoint(args: {
  checkpointId: string;
  status: "APPROVED" | "REJECTED";
  decisionPayload?: Prisma.InputJsonValue;
  rejectionReason?: string;
}): Promise<{ waitToken: string | null }> {
  const cp = await db.humanCheckpoint.update({
    where: { id: args.checkpointId },
    data: {
      status: args.status,
      decisionPayload: args.decisionPayload,
      rejectionReason: args.rejectionReason ?? null,
      decidedAt: new Date(),
    },
    select: { waitToken: true },
  });
  return cp;
}

export async function persistIncludedPapers(args: {
  runId: string;
  included: IncludedPaperSpec[];
}): Promise<void> {
  if (args.included.length === 0) return;
  await db.includedPaper.createMany({
    data: args.included.map((p) => ({
      runId: args.runId,
      corpusItemId: p.corpusItemId,
      relevanceScore: p.relevanceScore,
      inclusionReason: p.inclusionReason,
    })),
    skipDuplicates: true,
  });
}

export async function persistClaims(args: { runId: string; claims: ClaimSpec[] }): Promise<void> {
  if (args.claims.length === 0) return;
  // includedPaperId in state is the corpusItemId — resolve to the IncludedPaper row id here.
  const included = await db.includedPaper.findMany({
    where: { runId: args.runId },
    select: { id: true, corpusItemId: true },
  });
  const idByCorpus = new Map(included.map((i) => [i.corpusItemId, i.id]));
  const rows = args.claims
    .map((c) => {
      const inclId = idByCorpus.get(c.includedPaperId);
      if (!inclId) return null;
      return {
        runId: args.runId,
        includedPaperId: inclId,
        text: c.text,
        category: c.category,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length === 0) return;
  await db.extractedClaim.createMany({ data: rows });
}

export async function finishRun(args: { runId: string; draft: string }): Promise<void> {
  await db.run.update({
    where: { id: args.runId },
    data: { status: "COMPLETED", draft: args.draft, completedAt: new Date() },
  });
}

export async function failRun(args: { runId: string; reason: string }): Promise<void> {
  await db.run.update({
    where: { id: args.runId },
    data: { status: "FAILED", failureReason: args.reason.slice(0, 1000) },
  });
}
```

- [ ] **Step 4: Re-run, confirm new tests pass and old node tests still pass**

```bash
pnpm vitest run tests/lib/agent/
```

All 6 files (state, planner, retriever, assessor, drafter, runs) — every test must pass.

- [ ] **Step 5: Full suite + typecheck**

```bash
pnpm test
pnpm tsc --noEmit
```

Total tests: 60 (54 + 6 runs). Tsc clean.

- [ ] **Step 6: Commit**

```bash
git add lib/agent/runs.ts tests/lib/agent/runs.test.ts
git commit -m "feat: prisma-backed run/step/checkpoint/claim helpers"
```

---

## Task 9: Trigger.dev `run-review` task — the durability wrapper

**Files:**
- Create: `trigger/run-review.ts`
- Modify: `lib/trigger-client.ts` (add enqueueRunReview, resumeRun)
- Create: `tests/trigger/run-review.test.ts`

This task is the bridge between Trigger.dev's durable execution and LangGraph's `interrupt`/`Command.resume` model.

- [ ] **Step 1: Write the failing test**

`tests/trigger/run-review.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const metadata: { set: ReturnType<typeof vi.fn> } = { set: vi.fn() };
  metadata.set.mockReturnValue(metadata);
  const logger = { info: vi.fn(), error: vi.fn() };

  const waitToken = vi.fn();
  const tokenObj = { id: "tk_abc" };
  const waitCreateToken = vi.fn(async () => tokenObj);

  const graphInvoke = vi.fn();
  const graphGetState = vi.fn();
  const buildGraph = vi.fn(async () => ({
    invoke: graphInvoke,
    getState: graphGetState,
  }));

  return { metadata, logger, waitToken, waitCreateToken, graphInvoke, graphGetState, buildGraph };
});

vi.mock("@trigger.dev/sdk", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@trigger.dev/sdk");
  return {
    ...actual,
    schemaTask: (cfg: { run: (payload: unknown) => Promise<unknown> }) => cfg,
    logger: mocks.logger,
    metadata: mocks.metadata,
    wait: {
      createToken: mocks.waitCreateToken,
      forToken: mocks.waitToken,
    },
  };
});

vi.mock("@/lib/agent/graph", () => ({ buildGraph: mocks.buildGraph }));
vi.mock("@/lib/agent/runs", () => ({
  setRunStatus: vi.fn(),
  recordCheckpoint: vi.fn().mockResolvedValue({ id: "cp_1" }),
  persistIncludedPapers: vi.fn(),
  persistClaims: vi.fn(),
  finishRun: vi.fn(),
  failRun: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    project: { findUnique: vi.fn() },
    corpusItem: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import * as runs from "@/lib/agent/runs";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.metadata.set.mockReturnValue(mocks.metadata);
  vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", question: "Q?" } as never);
  vi.mocked(db.corpusItem.findMany).mockResolvedValue([
    { id: "c1", source: "corpus/p1/c1.pdf", summary: null, status: "PARSED" },
  ] as never);
});

describe("run-review task", () => {
  it("runs to completion when both gates auto-approve", async () => {
    // Sequence the graph: planner produces plan + interrupt, resume → retriever + interrupt, resume → done with draft
    mocks.graphInvoke
      .mockResolvedValueOnce({ __interrupt__: [{ value: { kind: "APPROVE_PLAN", plan: { picoc: {} } } }] })
      .mockResolvedValueOnce({
        __interrupt__: [{
          value: { kind: "APPROVE_PAPERS", includedPapers: [{ corpusItemId: "c1", relevanceScore: 0.9, inclusionReason: "x" }] },
        }],
      })
      .mockResolvedValueOnce({ draft: "# Review", includedPapers: [{ corpusItemId: "c1", relevanceScore: 0.9, inclusionReason: "x" }], claims: [{ includedPaperId: "c1", text: "F", category: "finding" }] });

    mocks.waitToken
      .mockResolvedValueOnce({ approved: true })
      .mockResolvedValueOnce({ approved: true, corpusItemIds: ["c1"] });

    const mod = await import("@/trigger/run-review");
    await mod.runReviewTask.run({ runId: "r1" });

    expect(runs.recordCheckpoint).toHaveBeenCalledTimes(2);
    expect(runs.persistIncludedPapers).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r1" }),
    );
    expect(runs.persistClaims).toHaveBeenCalled();
    expect(runs.finishRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "r1", draft: "# Review" }));
  });

  it("marks the run REJECTED when the plan gate is rejected", async () => {
    mocks.graphInvoke
      .mockResolvedValueOnce({ __interrupt__: [{ value: { kind: "APPROVE_PLAN", plan: { picoc: {} } } }] })
      .mockResolvedValueOnce({ planApproved: { approved: false, rejectionReason: "Out of scope" } });

    mocks.waitToken.mockResolvedValueOnce({ approved: false, rejectionReason: "Out of scope" });

    const mod = await import("@/trigger/run-review");
    await mod.runReviewTask.run({ runId: "r1" });

    expect(runs.finishRun).not.toHaveBeenCalled();
    expect(runs.failRun).not.toHaveBeenCalled();
    // status set to REJECTED in finally
    expect(runs.setRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r1", status: "REJECTED" }),
    );
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

```bash
pnpm vitest run tests/trigger/run-review.test.ts
```

- [ ] **Step 3: Implement `trigger/run-review.ts`**

```ts
import { schemaTask, logger, metadata, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { Command } from "@langchain/langgraph";
import { buildGraph } from "@/lib/agent/graph";
import {
  setRunStatus,
  recordCheckpoint,
  persistIncludedPapers,
  persistClaims,
  finishRun,
  failRun,
} from "@/lib/agent/runs";
import { db } from "@/lib/db";

export const runReviewTask = schemaTask({
  id: "run-review",
  schema: z.object({ runId: z.string() }),
  retry: { maxAttempts: 1 },
  machine: { preset: "small-2x" },
  maxDuration: 86400, // up to a day — runs can wait on HITL for a long time
  run: async ({ runId }) => {
    metadata.set("runId", runId);

    let finalState: unknown = null;
    try {
      // Hydrate initial agent state from DB
      const run = await db.run.findUniqueOrThrow({ where: { id: runId } } as never);
      const project = await db.project.findUnique({
        where: { id: (run as { projectId: string }).projectId },
        select: { question: true },
      });
      if (!project) throw new Error(`Project for run ${runId} not found`);

      const corpus = await db.corpusItem.findMany({
        where: { projectId: (run as { projectId: string }).projectId, status: "PARSED" },
        select: { id: true, source: true, summary: true, status: true },
      });

      const initial = {
        runId,
        projectId: (run as { projectId: string }).projectId,
        question: (run as { question: string }).question,
        candidateCorpusItems: corpus.map((c) => ({
          id: c.id,
          title: c.source.split("/").pop() ?? c.id,
          summary: c.summary as { abstract: string; studyType: string; relevanceToSLR: string } | null,
        })),
        plan: null,
        planApproved: null,
        includedPapers: [],
        papersApproved: null,
        claims: [],
        draft: null,
      };

      const graph = await buildGraph();
      const config = { configurable: { thread_id: runId } };

      // Drive the graph through interrupts
      let payload: unknown = initial;
      let lastState: { [k: string]: unknown; __interrupt__?: Array<{ value: unknown }> } = {};

      // Bound the loop — at most 6 segments (initial + 2 gates + tail). Defensive vs infinite resume.
      for (let segment = 0; segment < 6; segment++) {
        await setRunStatus({ runId, status: segmentStatus(segment) });
        lastState = (await graph.invoke(payload as never, config)) as typeof lastState;

        const interrupts = lastState.__interrupt__;
        if (!interrupts || interrupts.length === 0) break; // graph completed

        const intr = interrupts[0]!.value as
          | { kind: "APPROVE_PLAN"; plan: unknown }
          | { kind: "APPROVE_PAPERS"; includedPapers: unknown };

        // Create a wait token, persist a checkpoint that the UI can look up
        const token = await wait.createToken({ timeoutInSeconds: 86_400 });
        await recordCheckpoint({
          runId,
          kind: intr.kind,
          proposal: intr as never,
          waitToken: token.id,
        });

        await setRunStatus({
          runId,
          status: intr.kind === "APPROVE_PLAN" ? "AWAITING_PLAN_APPROVAL" : "AWAITING_PAPERS_APPROVAL",
        });

        // Block until the UI calls the approve/reject endpoint with the token id
        const decision = await wait.forToken<unknown>(token);

        // If the user rejected, write that into state and let the conditional edge route to END
        payload = new Command({ resume: decision });

        // Side-effect persistence: after the retriever segment, persist included papers
        if (intr.kind === "APPROVE_PAPERS") {
          const included = (intr as { includedPapers: Array<{ corpusItemId: string; relevanceScore: number; inclusionReason: string }> }).includedPapers;
          await persistIncludedPapers({ runId, included });
        }
      }

      finalState = lastState;

      // Persist claims and draft if the run reached the end
      const draft = lastState.draft as string | undefined | null;
      const claims = lastState.claims as Array<{ includedPaperId: string; text: string; category: "finding" | "methodology" | "limitation" | "context" }> | undefined;
      const planApproved = lastState.planApproved as { approved: boolean } | null | undefined;
      const papersApproved = lastState.papersApproved as { approved: boolean } | null | undefined;

      if (planApproved && !planApproved.approved) {
        await setRunStatus({ runId, status: "REJECTED" });
        return { ok: true, status: "REJECTED" };
      }
      if (papersApproved && !papersApproved.approved) {
        await setRunStatus({ runId, status: "REJECTED" });
        return { ok: true, status: "REJECTED" };
      }
      if (claims && claims.length > 0) await persistClaims({ runId, claims });
      if (draft) {
        await finishRun({ runId, draft });
        return { ok: true, status: "COMPLETED" };
      }

      // Should not get here in a healthy run
      await setRunStatus({ runId, status: "FAILED" });
      return { ok: false, status: "FAILED" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error("run-review failed", { reason, finalState });
      await failRun({ runId, reason });
      throw err;
    }
  },
});

function segmentStatus(segment: number):
  | "PLANNING"
  | "AWAITING_PLAN_APPROVAL"
  | "RETRIEVING"
  | "AWAITING_PAPERS_APPROVAL"
  | "ASSESSING"
  | "DRAFTING" {
  // Coarse mapping: each invoke segment moves us to the next visible phase
  switch (segment) {
    case 0: return "PLANNING";
    case 1: return "RETRIEVING";
    case 2: return "ASSESSING";
    case 3: return "DRAFTING";
    default: return "DRAFTING";
  }
}
```

- [ ] **Step 4: Append helpers to `lib/trigger-client.ts`**

```ts
import type { runReviewTask } from "@/trigger/run-review";

export async function enqueueRunReview(runId: string): Promise<{ id: string }> {
  const handle = await tasks.trigger<typeof runReviewTask>("run-review", { runId });
  return { id: handle.id };
}

// Resume a paused run by completing its wait token
export async function resolveWaitToken(token: string, payload: unknown): Promise<void> {
  await wait.completeToken(token, payload);
}
```

The `wait.completeToken` import needs to be added at top of `lib/trigger-client.ts` if not already:

```ts
import { tasks, wait } from "@trigger.dev/sdk";
```

- [ ] **Step 5: Re-run, confirm 2/2 pass**

```bash
pnpm vitest run tests/trigger/run-review.test.ts
```

If `wait.completeToken` does not exist in v4, check the actual API — it might be `wait.complete(token, payload)` or `tokens.complete(...)`. Adapt and report.

- [ ] **Step 6: Full suite + typecheck**

```bash
pnpm test
pnpm tsc --noEmit
```

Total tests: 62 (60 + 2). Tsc clean.

- [ ] **Step 7: Commit**

```bash
git add trigger/run-review.ts lib/trigger-client.ts tests/trigger/run-review.test.ts
git commit -m "feat: durable run-review task with HITL pause/resume"
```

---

## Task 10: API routes — start run, get run, approve/reject checkpoint

**Files:**
- Create: `app/api/projects/[id]/runs/route.ts`
- Create: `app/api/runs/[id]/route.ts`
- Create: `app/api/runs/[id]/checkpoints/[cpId]/approve/route.ts`
- Create: `app/api/runs/[id]/checkpoints/[cpId]/reject/route.ts`
- Create: `tests/api/runs-start.test.ts`
- Create: `tests/api/runs-get.test.ts`
- Create: `tests/api/checkpoint-approve.test.ts`

- [ ] **Step 1: Write the failing test for `POST /api/projects/[id]/runs`**

`tests/api/runs-start.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    project: { findUnique: vi.fn() },
    corpusItem: { count: vi.fn() },
  },
}));
vi.mock("@/lib/agent/runs", () => ({ createRun: vi.fn() }));
vi.mock("@/lib/trigger-client", () => ({
  enqueueRunReview: vi.fn(),
  enqueueParsePdf: vi.fn(),
  enqueueSummarizePaper: vi.fn(),
  resolveWaitToken: vi.fn(),
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { createRun } from "@/lib/agent/runs";
import { enqueueRunReview } from "@/lib/trigger-client";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/projects/[id]/runs", () => {
  it("creates a run and enqueues the task", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "Q?" } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(3 as never);
    vi.mocked(createRun).mockResolvedValue({ id: "r1" } as never);
    vi.mocked(enqueueRunReview).mockResolvedValue({ id: "trigger_run_abc" } as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toBe("r1");
    expect(createRun).toHaveBeenCalledWith({ projectId: "p1", question: "Q?" });
    expect(enqueueRunReview).toHaveBeenCalledWith("r1");
  });

  it("returns 404 for a project the user doesn't own", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u2", question: "x" } as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 if the project has zero PARSED corpus items", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "x" } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(0 as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

```bash
pnpm vitest run tests/api/runs-start.test.ts
```

- [ ] **Step 3: Implement `app/api/projects/[id]/runs/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { createRun } from "@/lib/agent/runs";
import { enqueueRunReview } from "@/lib/trigger-client";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project || project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }

  const corpusCount = await db.corpusItem.count({
    where: { projectId: id, status: "PARSED" },
  });
  if (corpusCount === 0) {
    return NextResponse.json(
      { error: "Project has no PARSED corpus items to review. Upload and parse at least one PDF first." },
      { status: 409 },
    );
  }

  const run = await createRun({ projectId: id, question: project.question });
  await enqueueRunReview(run.id);

  return NextResponse.json({ runId: run.id }, { status: 201 });
}
```

- [ ] **Step 4: Re-run, confirm 3/3 pass**

```bash
pnpm vitest run tests/api/runs-start.test.ts
```

- [ ] **Step 5: Write the failing test for `GET /api/runs/[id]`**

`tests/api/runs-get.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    run: { findUnique: vi.fn() },
  },
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/runs/[id]", () => {
  it("returns the run + steps + checkpoints when owned", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      id: "r1",
      status: "AWAITING_PLAN_APPROVAL",
      project: { ownerId: "u1" },
      steps: [{ id: "s1", nodeName: "planner" }],
      checkpoints: [{ id: "cp1", kind: "APPROVE_PLAN", status: "PENDING" }],
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/route");
    const res = await GET(new NextRequest("http://localhost/api/runs/r1"), {
      params: Promise.resolve({ id: "r1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; steps: unknown[]; checkpoints: unknown[] };
    expect(body.id).toBe("r1");
    expect(body.steps).toHaveLength(1);
    expect(body.checkpoints).toHaveLength(1);
  });

  it("returns 404 for non-owner", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      id: "r1",
      project: { ownerId: "u2" },
      steps: [],
      checkpoints: [],
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/route");
    const res = await GET(new NextRequest("http://localhost/api/runs/r1"), {
      params: Promise.resolve({ id: "r1" }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 6: Run, confirm FAIL**

```bash
pnpm vitest run tests/api/runs-get.test.ts
```

- [ ] **Step 7: Implement `app/api/runs/[id]/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const run = await db.run.findUnique({
    where: { id },
    include: {
      project: { select: { ownerId: true } },
      steps: { orderBy: { startedAt: "asc" } },
      checkpoints: { orderBy: { createdAt: "asc" } },
      includedPapers: true,
    },
  });
  if (!run || run.project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }
  return NextResponse.json(run);
}
```

- [ ] **Step 8: Re-run, confirm 2/2 pass**

```bash
pnpm vitest run tests/api/runs-get.test.ts
```

- [ ] **Step 9: Write the failing test for the approve/reject endpoints**

`tests/api/checkpoint-approve.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    humanCheckpoint: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/agent/runs", () => ({
  resolveCheckpoint: vi.fn(),
}));
vi.mock("@/lib/trigger-client", () => ({
  resolveWaitToken: vi.fn(),
  enqueueRunReview: vi.fn(),
  enqueueParsePdf: vi.fn(),
  enqueueSummarizePaper: vi.fn(),
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveCheckpoint } from "@/lib/agent/runs";
import { resolveWaitToken } from "@/lib/trigger-client";

beforeEach(() => vi.clearAllMocks());

const buildReq = (body: unknown) =>
  new NextRequest("http://localhost/api/runs/r1/checkpoints/cp1/approve", {
    method: "POST",
    body: JSON.stringify(body),
  });

describe("POST /api/runs/[id]/checkpoints/[cpId]/approve", () => {
  it("marks the checkpoint approved and completes the wait token", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    vi.mocked(resolveCheckpoint).mockResolvedValue({ waitToken: "tk_xyz" } as never);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const res = await POST(buildReq({ corpusItemIds: ["c1", "c2"] }), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(200);
    expect(resolveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointId: "cp1", status: "APPROVED" }),
    );
    expect(resolveWaitToken).toHaveBeenCalledWith(
      "tk_xyz",
      expect.objectContaining({ approved: true, corpusItemIds: ["c1", "c2"] }),
    );
  });

  it("returns 404 for non-owner", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u2" } },
    } as never);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const res = await POST(buildReq({}), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 if checkpoint is already resolved", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "APPROVED",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const res = await POST(buildReq({}), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 10: Run, confirm FAIL**

```bash
pnpm vitest run tests/api/checkpoint-approve.test.ts
```

- [ ] **Step 11: Implement the approve and reject route handlers**

`app/api/runs/[id]/checkpoints/[cpId]/approve/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveCheckpoint } from "@/lib/agent/runs";
import { resolveWaitToken } from "@/lib/trigger-client";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; cpId: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id: _runId, cpId } = await params;
  const cp = await db.humanCheckpoint.findUnique({
    where: { id: cpId },
    include: { run: { include: { project: { select: { ownerId: true } } } } },
  });
  if (!cp || cp.run.project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }
  if (cp.status !== "PENDING") {
    return NextResponse.json({ error: "Checkpoint already resolved" }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // For APPROVE_PAPERS the body should contain corpusItemIds; for APPROVE_PLAN no body needed
  const decisionPayload = { approved: true, ...body };

  const resolved = await resolveCheckpoint({
    checkpointId: cpId,
    status: "APPROVED",
    decisionPayload,
  });
  if (resolved.waitToken) {
    await resolveWaitToken(resolved.waitToken, decisionPayload);
  }

  return NextResponse.json({ ok: true });
}
```

`app/api/runs/[id]/checkpoints/[cpId]/reject/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveCheckpoint } from "@/lib/agent/runs";
import { resolveWaitToken } from "@/lib/trigger-client";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; cpId: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { cpId } = await params;
  const cp = await db.humanCheckpoint.findUnique({
    where: { id: cpId },
    include: { run: { include: { project: { select: { ownerId: true } } } } },
  });
  if (!cp || cp.run.project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }
  if (cp.status !== "PENDING") {
    return NextResponse.json({ error: "Checkpoint already resolved" }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  const reason = body.reason ?? "rejected";
  const decisionPayload = { approved: false, rejectionReason: reason };

  const resolved = await resolveCheckpoint({
    checkpointId: cpId,
    status: "REJECTED",
    decisionPayload,
    rejectionReason: reason,
  });
  if (resolved.waitToken) {
    await resolveWaitToken(resolved.waitToken, decisionPayload);
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 12: Re-run all 3 API test files**

```bash
pnpm vitest run tests/api/runs-start.test.ts tests/api/runs-get.test.ts tests/api/checkpoint-approve.test.ts
```

8 tests across the three files must pass.

- [ ] **Step 13: Full suite + typecheck**

```bash
pnpm test
pnpm tsc --noEmit
```

Total tests: 70 (62 + 3 + 2 + 3). Tsc clean.

- [ ] **Step 14: Commit**

```bash
git add app/api/projects/[id]/runs app/api/runs tests/api/runs-start.test.ts tests/api/runs-get.test.ts tests/api/checkpoint-approve.test.ts
git commit -m "feat: api routes for starting runs and resolving HITL checkpoints"
```

---

## Task 11: UI — Start Review button + Run page + approval cards

**Files:**
- Create: `components/runs/start-review-button.tsx`
- Create: `components/runs/run-status-pill.tsx`
- Create: `components/runs/run-step-list.tsx`
- Create: `components/runs/plan-approval-card.tsx`
- Create: `components/runs/papers-approval-card.tsx`
- Create: `components/runs/draft-view.tsx`
- Create: `app/projects/[id]/runs/[runId]/page.tsx`
- Modify: `app/projects/[id]/page.tsx` (add the Start Review button + runs list)

- [ ] **Step 1: Create the Start Review button**

`components/runs/start-review-button.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function StartReviewButton({ projectId, disabled }: { projectId: string; disabled?: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function start() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/projects/${projectId}/runs`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Failed (${res.status})`);
        return;
      }
      const { runId } = (await res.json()) as { runId: string };
      router.push(`/projects/${projectId}/runs/${runId}`);
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <Button onClick={start} disabled={isPending || disabled}>
        {isPending ? "Starting…" : "Start review"}
      </Button>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Create the run-status pill**

`components/runs/run-status-pill.tsx`:

```tsx
import { Badge } from "@/components/ui/badge";

export type RunStatus =
  | "PENDING"
  | "PLANNING"
  | "AWAITING_PLAN_APPROVAL"
  | "RETRIEVING"
  | "AWAITING_PAPERS_APPROVAL"
  | "ASSESSING"
  | "DRAFTING"
  | "COMPLETED"
  | "REJECTED"
  | "FAILED";

const VARIANT: Record<RunStatus, "default" | "secondary" | "outline" | "destructive"> = {
  PENDING: "outline",
  PLANNING: "secondary",
  AWAITING_PLAN_APPROVAL: "default",
  RETRIEVING: "secondary",
  AWAITING_PAPERS_APPROVAL: "default",
  ASSESSING: "secondary",
  DRAFTING: "secondary",
  COMPLETED: "default",
  REJECTED: "destructive",
  FAILED: "destructive",
};

export function RunStatusPill({ status }: { status: RunStatus }) {
  return <Badge variant={VARIANT[status]}>{status.toLowerCase().replace(/_/g, " ")}</Badge>;
}
```

- [ ] **Step 3: Create the run step list**

`components/runs/run-step-list.tsx`:

```tsx
type Step = {
  id: string;
  nodeName: string;
  startedAt: Date | string;
  endedAt: Date | string | null;
  traceUrl: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  failureReason: string | null;
};

export function RunStepList({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return <p className="text-muted-foreground text-sm">No steps yet.</p>;

  return (
    <ol className="space-y-2 text-sm">
      {steps.map((s) => (
        <li key={s.id} className="flex items-center justify-between rounded border bg-card px-3 py-2">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-muted-foreground">
              {s.endedAt ? "✓" : "…"}
            </span>
            <span className="font-medium">{s.nodeName}</span>
            {s.failureReason && (
              <span className="text-destructive text-xs">{s.failureReason}</span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>in {s.inputTokens} · out {s.outputTokens}</span>
            {s.traceUrl && (
              <a href={s.traceUrl} target="_blank" rel="noreferrer" className="underline">
                trace ↗
              </a>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 4: Create the plan approval card**

`components/runs/plan-approval-card.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Plan = {
  picoc: { population: string; intervention: string; comparison: string; outcome: string; context: string };
  subQuestions: string[];
  inclusionCriteria: string[];
  exclusionCriteria: string[];
};

export function PlanApprovalCard({
  runId,
  checkpointId,
  plan,
}: {
  runId: string;
  checkpointId: string;
  plan: Plan;
}) {
  const [isPending, startTransition] = useTransition();
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);
  const router = useRouter();

  function approve() {
    startTransition(async () => {
      await fetch(`/api/runs/${runId}/checkpoints/${checkpointId}/approve`, { method: "POST" });
      router.refresh();
    });
  }

  function reject() {
    startTransition(async () => {
      await fetch(`/api/runs/${runId}/checkpoints/${checkpointId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: rejectReason }),
      });
      router.refresh();
    });
  }

  return (
    <Card className="p-5 space-y-4 border-primary">
      <div>
        <h3 className="text-lg font-semibold">Review proposed plan</h3>
        <p className="text-sm text-muted-foreground">
          The planner produced this plan. Approve to start retrieving papers, or reject and the run ends.
        </p>
      </div>

      <section className="text-sm">
        <h4 className="font-medium mb-2">PICOC</h4>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {Object.entries(plan.picoc).map(([k, v]) => (
            <div key={k} className="rounded border p-2">
              <dt className="text-xs uppercase text-muted-foreground">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="text-sm">
        <h4 className="font-medium mb-1">Sub-questions</h4>
        <ul className="list-disc pl-5 space-y-1">{plan.subQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
      </section>

      <section className="text-sm grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <h4 className="font-medium mb-1">Inclusion criteria</h4>
          <ul className="list-disc pl-5 space-y-1">{plan.inclusionCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </div>
        <div>
          <h4 className="font-medium mb-1">Exclusion criteria</h4>
          <ul className="list-disc pl-5 space-y-1">{plan.exclusionCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </div>
      </section>

      {showReject ? (
        <div className="space-y-2">
          <Textarea
            placeholder="Why are you rejecting this plan?"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShowReject(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={reject} disabled={isPending || !rejectReason}>
              {isPending ? "Rejecting…" : "Confirm reject"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 justify-end">
          <Button variant="outline" onClick={() => setShowReject(true)} disabled={isPending}>
            Reject
          </Button>
          <Button onClick={approve} disabled={isPending}>
            {isPending ? "Approving…" : "Approve plan"}
          </Button>
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Step 5: Create the papers approval card**

`components/runs/papers-approval-card.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type IncludedPaper = {
  corpusItemId: string;
  relevanceScore: number;
  inclusionReason: string;
};

export function PapersApprovalCard({
  runId,
  checkpointId,
  proposed,
}: {
  runId: string;
  checkpointId: string;
  proposed: IncludedPaper[];
}) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(proposed.map((p) => p.corpusItemId)),
  );
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function approve() {
    startTransition(async () => {
      await fetch(`/api/runs/${runId}/checkpoints/${checkpointId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ corpusItemIds: [...selected] }),
      });
      router.refresh();
    });
  }

  function reject() {
    startTransition(async () => {
      await fetch(`/api/runs/${runId}/checkpoints/${checkpointId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "User aborted at papers gate" }),
      });
      router.refresh();
    });
  }

  return (
    <Card className="p-5 space-y-4 border-primary">
      <div>
        <h3 className="text-lg font-semibold">Approve included papers</h3>
        <p className="text-sm text-muted-foreground">
          The retriever scored each corpus item. Uncheck any you don't want included. {selected.size} of {proposed.length} selected.
        </p>
      </div>

      <ul className="space-y-2 text-sm">
        {proposed.map((p) => (
          <li key={p.corpusItemId} className="flex items-start gap-3 rounded border p-3">
            <input
              type="checkbox"
              checked={selected.has(p.corpusItemId)}
              onChange={() => toggle(p.corpusItemId)}
              className="mt-1"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs">{p.corpusItemId}</span>
                <span className="text-xs text-muted-foreground">score {p.relevanceScore.toFixed(2)}</span>
              </div>
              <p className="text-muted-foreground mt-1">{p.inclusionReason}</p>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={reject} disabled={isPending}>
          Reject all
        </Button>
        <Button onClick={approve} disabled={isPending || selected.size === 0}>
          {isPending ? "Approving…" : `Approve ${selected.size}`}
        </Button>
      </div>
    </Card>
  );
}
```

- [ ] **Step 6: Create the draft view**

`components/runs/draft-view.tsx`:

```tsx
import { Card } from "@/components/ui/card";

export function DraftView({ draft }: { draft: string }) {
  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold mb-3">Draft review</h3>
      <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans">{draft}</pre>
    </Card>
  );
}
```

- [ ] **Step 7: Create the run workspace page**

`app/projects/[id]/runs/[runId]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { RunStatusPill, type RunStatus } from "@/components/runs/run-status-pill";
import { RunStepList } from "@/components/runs/run-step-list";
import { PlanApprovalCard } from "@/components/runs/plan-approval-card";
import { PapersApprovalCard } from "@/components/runs/papers-approval-card";
import { DraftView } from "@/components/runs/draft-view";

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id: projectId, runId } = await params;
  const user = await requireUser();

  const run = await db.run.findUnique({
    where: { id: runId },
    include: {
      project: { select: { ownerId: true, title: true, question: true } },
      steps: { orderBy: { startedAt: "asc" } },
      checkpoints: { where: { status: "PENDING" }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!run || run.project.ownerId !== user.id) notFound();

  const pendingPlan = run.checkpoints.find((c) => c.kind === "APPROVE_PLAN");
  const pendingPapers = run.checkpoints.find((c) => c.kind === "APPROVE_PAPERS");

  return (
    <main className="max-w-5xl mx-auto px-6 py-10 space-y-8">
      <header className="space-y-2">
        <p className="text-xs text-muted-foreground">
          <a href={`/projects/${projectId}`} className="underline">{run.project.title}</a> / run
        </p>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{run.question}</h1>
          <RunStatusPill status={run.status as RunStatus} />
        </div>
        {run.failureReason && <p className="text-destructive text-sm">{run.failureReason}</p>}
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Steps</h2>
        <RunStepList steps={run.steps as never} />
      </section>

      {pendingPlan && (
        <PlanApprovalCard
          runId={runId}
          checkpointId={pendingPlan.id}
          plan={(pendingPlan.proposal as { plan: never }).plan ?? (pendingPlan.proposal as never)}
        />
      )}

      {pendingPapers && (
        <PapersApprovalCard
          runId={runId}
          checkpointId={pendingPapers.id}
          proposed={(pendingPapers.proposal as { includedPapers: never }).includedPapers ?? []}
        />
      )}

      {run.draft && <DraftView draft={run.draft} />}

      <RefreshTick run={run} />
    </main>
  );
}

// Client component: poll while running until terminal
import { RefreshTick } from "@/components/runs/refresh-tick";
```

Actually that last import is forward-defined. Create the file:

`components/runs/refresh-tick.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function RefreshTick({ run }: { run: { status: string } }) {
  const router = useRouter();
  useEffect(() => {
    const terminal = ["COMPLETED", "REJECTED", "FAILED"];
    if (terminal.includes(run.status)) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [run.status, router]);
  return null;
}
```

- [ ] **Step 8: Modify `app/projects/[id]/page.tsx`**

Add the Start Review button and a runs list. Open the file and add at the top:

```tsx
import { StartReviewButton } from "@/components/runs/start-review-button";
import Link from "next/link";
import { RunStatusPill, type RunStatus } from "@/components/runs/run-status-pill";
```

Modify the `db.project.findUnique` call to also include runs:

```tsx
  const project = await db.project.findUnique({
    where: { id },
    include: {
      corpus: { orderBy: { createdAt: "desc" } },
      runs: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
```

Then add a section to the JSX, after the Corpus section (the existing `<section>` containing `<CorpusItemList>`):

```tsx
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
```

- [ ] **Step 9: Typecheck + full suite**

```bash
pnpm tsc --noEmit
pnpm test
```

Tsc clean. Total tests: 70 (no new tests in this task — UI smoke covered manually).

- [ ] **Step 10: Commit**

```bash
git add components/runs/ app/projects/[id]/runs/ app/projects/[id]/page.tsx
git commit -m "feat: ui for starting reviews and resolving HITL gates"
```

---

## Task 12: Smoke + release

**Files:**
- Modify: `README.md`
- Create: `docs/blog/03-agent-loop-hitl.md`

- [ ] **Step 1: Final verification**

```bash
pnpm tsc --noEmit
pnpm test
git status
```

Tsc clean, 70 tests pass, working tree clean.

- [ ] **Step 2: Boundary smoke (no real LLM)**

```bash
docker compose ps
curl -fsS http://localhost:3030/api/public/health && echo " Langfuse OK"
```

Both healthy. Sign in to Atlas at `http://localhost:3001`, open a project with at least one PARSED corpus item, confirm the "Start review" button is visible. **Do not click it** — without an `ANTHROPIC_API_KEY`, the planner would fail with the clear `getAnthropic()` error.

- [ ] **Step 3: Update `README.md`**

Open `README.md`. Find the "Shipped" section and add:

```markdown
### M3 — Agent Loop + HITL (`v0.3.0-m3`)
- LangGraph state machine: planner → retriever → assessor → drafter, with two HITL gates (approve plan, approve papers)
- Trigger.dev `run-review` task wraps the graph for durability: `interrupt()` produces a checkpoint, `wait.forToken()` pauses the worker, the UI approves to resume
- Schema: Run, RunStep, HumanCheckpoint, IncludedPaper, ExtractedClaim
- UI: Start Review button on project page; live run workspace with progress, plan-approval card, papers-approval checklist, and rendered draft review
- All four agent nodes go through the M2 `runLLM` wrapper — same Langfuse trace per call, same Zod validation, same cost capture
- 70 tests passing
```

Update the Roadmap line:

```markdown
- ~~**M3** (Wk 4): Full agent loop (planner → retriever → assessor → drafter) + HITL gates + Hetzner deployment~~ ✅ shipped as `v0.3.0-m3` (code only — Hetzner deployment is the deferred M3.5 task)
```

Add a deferred-work note at the bottom of the README:

```markdown
## Deferred from M3
- **M3.5 — Hetzner deployment.** The agent code ships at M3, but a public live demo at `atlas.review` (or alternative domain) is the M3.5 task, requiring (a) a domain Ahmed registers and (b) a Hetzner CX22 in Falkenstein. Estimated 3-4 hours of work once both are in hand.
```

- [ ] **Step 4: Create the M3 blog post skeleton**

`docs/blog/03-agent-loop-hitl.md`:

```markdown
# Atlas, weeks 3-4: the agent loop

The third post in a series documenting an open-source agentic literature-review platform.

## What I shipped

- A four-node LangGraph state machine: planner, retriever, assessor, drafter
- Two human-in-the-loop approval gates — approve the plan before retrieval, approve included papers before extraction
- Trigger.dev as the durability wrapper around LangGraph: `interrupt()` produces a checkpoint, `wait.forToken()` pauses the worker, the UI resumes via API
- Schema for Run / RunStep / HumanCheckpoint / IncludedPaper / ExtractedClaim — every step traceable from the dashboard
- All four nodes go through the same `runLLM` wrapper from M2 — every call is a Langfuse span with cost and validation

## Why I integrated LangGraph with Trigger.dev (and not just used one)

[Explain: LangGraph's checkpointer survives in-process state. Trigger.dev survives the WORKER restart. HITL gates that wait hours or days need worker-restart durability. The marriage is: LangGraph runs node-to-node, Trigger.dev wraps the whole driver loop and uses wait.forToken at each interrupt boundary.]

## The HITL gate pattern

[Walk through `interrupt(proposal)` → wait token created → recordCheckpoint persisted → wait.forToken blocks → UI POSTs to /api/.../approve → resolveWaitToken completes → graph resumes with Command.resume(decision).]

## Designing the agent state shape

[Why each channel exists, what the reducer pattern protects against, why HITL decisions are nullable.]

## What's missing — and what M4 adds

- No web search (Exa) or OpenAlex — retriever scores only papers already in the corpus
- No `cite_check` — the draft cites paper ids but no automated verification that the claim is actually supported by the paper
- No critic loop — drafter output is final after one pass
- No eval harness yet

M4 closes all four.
```

- [ ] **Step 5: Commit docs**

```bash
git add README.md docs/blog/03-agent-loop-hitl.md
git commit -m "docs: m3 readme update + blog post skeleton"
```

- [ ] **Step 6: Tag the release**

```bash
git tag -a v0.3.0-m3 -m "M3: full agent loop with HITL gates

Four-node LangGraph state machine (planner → retriever → assessor → drafter)
with two human-in-the-loop approval gates. Trigger.dev wraps the graph for
durability — HITL pauses can survive worker restarts via wait.forToken.

Schema for Run, RunStep, HumanCheckpoint, IncludedPaper, ExtractedClaim.
UI for starting reviews, watching progress, approving gates, reading drafts.

All four nodes use the M2 runLLM wrapper — same Langfuse trace, cost capture,
Zod validation. 70 tests pass; all Anthropic SDK usage mocked, no real LLM
calls anywhere.

Hetzner deployment deferred to M3.5 pending domain registration.

See docs/superpowers/specs/2026-05-22-atlas-design.md for the design and
docs/superpowers/plans/2026-05-22-m3-agent-loop-hitl.md for the milestone plan."
```

- [ ] **Step 7: Push + release**

```bash
git push origin master
git push origin v0.3.0-m3
gh release create v0.3.0-m3 \
  --title "M3: Full Agent Loop + HITL Gates" \
  --notes "Adds the LangGraph agent loop with HITL approval gates. Planner → retriever → assessor → drafter, each as a node going through the M2 runLLM wrapper. Trigger.dev wraps the graph for durability across HITL pauses via wait.forToken. 70 tests pass; all Anthropic SDK usage mocked. Hetzner live deploy deferred to M3.5. See docs/blog/03-agent-loop-hitl.md for the writeup."
```

- [ ] **Step 8: Sanity check**

```bash
gh release list --repo ahmedEid1/atlas
```

`v0.3.0-m3` should appear at the top.

---

## Definition of done for M3

- [ ] 70 Vitest tests pass: `pnpm test`
- [ ] Typecheck passes: `pnpm tsc --noEmit`
- [ ] Docker stack healthy
- [ ] "Start review" button renders on a project with PARSED corpus items
- [ ] Run page renders for an existing run (any status); approval cards render when a PENDING checkpoint exists
- [ ] `v0.3.0-m3` tag pushed to GitHub with a Release
- [ ] Blog post skeleton at `docs/blog/03-agent-loop-hitl.md`
- [ ] README updated to reflect shipped state, M3.5 deferred-work note added
- [ ] No `any` types in any committed code
- [ ] **No real LLM calls anywhere** — all Anthropic SDK usage mocked; live smoke deferred until Ahmed provides `ANTHROPIC_API_KEY`
- [ ] **Hetzner deployment is NOT in this milestone** — tracked as M3.5

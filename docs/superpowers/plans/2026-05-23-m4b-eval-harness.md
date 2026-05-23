# M4b — Eval Harness + Public /evals Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained eval harness for Atlas: 10 golden SLR questions in `evals/golden/*.yaml`, a headless graph runner that exercises Atlas without HITL gates, 4 metrics (citation recall / precision / faithfulness / expected-claim coverage), GitHub Actions integration (push + nightly), regression gate (>10% drop fails CI), and a public server-rendered `/evals` dashboard at `https://atlas-sooty-delta.vercel.app/evals`.

**Architecture:** Each golden question is a YAML file declaring `{question, picoc, papers[inline markdown], expectedPapers[ids], expectedClaims[strings]}`. The eval runner creates an ephemeral Project in Atlas, inserts pre-parsed CorpusItem rows from the YAML (skipping marker-pdf + summarisation to keep evals fast and cheap), and calls a new `runHeadless({question, corpusItemIds, userId})` helper that drives the M3+M4a LangGraph in-process with auto-approved HITL gates. Per-question metrics are computed against the resulting `Run`'s `includedPapers`, `draft`, and `claimChecks`. Results land in a new `EvalRun` table; the `/evals` page reads aggregates from there.

**Tech Stack:** Atlas's existing LangGraph + Prisma + Neon, Zod for golden-question schema, `js-yaml` for parsing, hand-rolled runner (no Promptfoo dep — see "Deviation" below).

**Spec:** `docs/superpowers/specs/2026-05-23-m4-critic-cite-check-evals-design.md` §5

**Builds on:** `v0.4.0-m4a` (critic + cite_check live)

**Ship target:** `v0.4.1-m4b` tagged on GitHub, public dashboard live, 10 golden questions, GitHub Actions running on push + nightly.

---

## Deviation from spec §5.2

The spec named **Promptfoo** as the eval framework. After mapping it to Atlas's actual shape (Atlas produces structured `Run` outputs — included papers, draft markdown, claim checks — not a text completion against a single prompt), Promptfoo's `provider` + `test` abstraction would require a wrapper that's almost as much code as just writing the runner directly. We go with a hand-rolled `scripts/run-evals.ts` that loops over golden questions, drives the headless graph, and computes metrics. The hiring signal (eval methodology, metrics, CI gate, public dashboard) is preserved; the library name is not load-bearing. README will document the choice ("Promptfoo considered, hand-rolled to match Atlas's structured output").

---

## File structure (locked in here)

**New files:**
- `evals/README.md` — what the eval harness is, how to add a question, how to run locally
- `evals/golden/000-*.yaml` through `009-*.yaml` — 10 golden questions (drafted in Task 9, approved by Ahmed)
- `lib/eval/golden-schema.ts` — Zod schema for golden question YAML
- `lib/eval/golden-loader.ts` — `loadGolden(): Promise<GoldenQuestion[]>` reading `evals/golden/*.yaml`
- `lib/eval/headless-runner.ts` — `runHeadless({question, corpusItemIds, userId, runId}): Promise<HeadlessRunResult>` — drives LangGraph in-process with auto-approved HITL
- `lib/eval/metrics.ts` — pure functions: `citationRecall`, `citationPrecision`, `claimFaithfulness`, `expectedClaimCoverage`
- `lib/eval/seed-corpus.ts` — `seedEvalProject(golden): Promise<{projectId, corpusItemIds, userId}>` — creates an ephemeral User/Project/CorpusItems for one eval run
- `scripts/run-evals.ts` — orchestrator: loads goldens, seeds corpus, runs headless, computes metrics, writes EvalRun rows, outputs JSON to `eval-results.json`
- `scripts/check-eval-regression.ts` — reads `eval-results.json`, compares to the last main-branch EvalRun rows, exits non-zero if any metric drops > 10%
- `.github/workflows/evals.yml` — CI workflow (push + nightly cron)
- `app/evals/page.tsx` — public server-rendered dashboard (reads EvalRun rows)
- `components/evals/MetricCard.tsx` — single-metric trend tile
- `components/evals/QuestionRow.tsx` — per-question scores row in the table
- `tests/lib/eval/golden-schema.test.ts`
- `tests/lib/eval/golden-loader.test.ts`
- `tests/lib/eval/headless-runner.test.ts`
- `tests/lib/eval/metrics.test.ts`
- `tests/lib/eval/seed-corpus.test.ts`

**Modified files:**
- `prisma/schema.prisma` — add `EvalRun` model + index
- `prisma/migrations/<new>/migration.sql` — auto-generated
- `package.json` — add `js-yaml` + `@types/js-yaml`; add new `eval`/`eval:check` scripts
- `README.md` — add eval-harness section + live `/evals` link

**Total:** ~14 new source files + 5 test files + 10 golden YAMLs + 1 workflow + 1 migration.

---

## Task 0: Prisma schema — add `EvalRun`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_eval_run/migration.sql`

- [ ] **Step 1: Append `EvalRun` model to `prisma/schema.prisma`** (at the very bottom of the file, after `ClaimCheck`)

```prisma
model EvalRun {
  id        String   @id @default(cuid())
  goldenId  String   // e.g., "000-cbt-back-pain"
  metric    String   // "citation_recall" | "citation_precision" | "claim_faithfulness" | "expected_claim_coverage"
  score     Float    // 0.0-1.0
  runId     String?  // optional FK-ish link to the underlying Atlas Run (not enforced; eval runs may delete the Run row afterwards)
  commitSha String   // git commit at time of run
  createdAt DateTime @default(now())

  @@index([goldenId, createdAt])
  @@index([commitSha])
}
```

- [ ] **Step 2: Generate + apply the migration**

```bash
pnpm prisma migrate dev --name add_eval_run
```

Expected: succeeds against Neon, prints `Your database is now in sync with your schema.`

If shadow-DB error (Neon free tier), use the two-step variant:
```bash
pnpm prisma migrate dev --create-only --name add_eval_run
pnpm prisma migrate deploy
pnpm prisma generate
```

- [ ] **Step 3: Verify table is reachable**

```bash
pnpm tsx -e "import 'dotenv/config'; import { db } from './lib/db'; (async () => { const ct = await db.evalRun.count(); console.log('EvalRun table reachable, rows:', ct); await db.\$disconnect(); })()"
```

Expected: `EvalRun table reachable, rows: 0`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): add EvalRun table for eval harness

Per-metric scores tied to a goldenId + commitSha. Indexed by
(goldenId, createdAt) for trend queries and by commitSha for
regression comparisons. No foreign key to Run since eval projects
get deleted after each run."
```

---

## Task 1: Golden question Zod schema

**Files:**
- Create: `lib/eval/golden-schema.ts`
- Create: `tests/lib/eval/golden-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/eval/golden-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GoldenQuestionSchema } from "@/lib/eval/golden-schema";

const validGolden = {
  id: "000-test",
  question: "Does X improve Y?",
  picoc: {
    population: "Adults",
    intervention: "X",
    comparison: "Standard care",
    outcome: "Y",
    context: "Clinical trials",
  },
  papers: [
    {
      id: "paper_001",
      title: "Effect of X on Y",
      summary: "RCT of X vs control. Found 25% improvement in Y at 6 months.",
      markdown: "# Effect of X on Y\n\nFull paper text here...",
    },
  ],
  expectedPapers: ["paper_001"],
  expectedClaims: ["X improves Y by ~25%"],
  metadata: {
    source: "Cochrane Review CDxxxxxx",
    difficulty: "medium",
  },
};

describe("GoldenQuestionSchema", () => {
  it("accepts a valid golden question", () => {
    const r = GoldenQuestionSchema.safeParse(validGolden);
    expect(r.success).toBe(true);
  });

  it("requires id, question, picoc, papers, expectedPapers, expectedClaims", () => {
    const missing = { ...validGolden };
    delete (missing as Record<string, unknown>).question;
    expect(GoldenQuestionSchema.safeParse(missing).success).toBe(false);
  });

  it("rejects empty papers array (a question needs evaluable corpus)", () => {
    expect(GoldenQuestionSchema.safeParse({ ...validGolden, papers: [] }).success).toBe(false);
  });

  it("rejects expectedPapers that reference unknown paper ids", () => {
    const r = GoldenQuestionSchema.safeParse({
      ...validGolden,
      expectedPapers: ["paper_999"],
    });
    expect(r.success).toBe(false);
  });

  it("accepts difficulty as easy/medium/hard", () => {
    for (const d of ["easy", "medium", "hard"] as const) {
      const r = GoldenQuestionSchema.safeParse({
        ...validGolden,
        metadata: { ...validGolden.metadata, difficulty: d },
      });
      expect(r.success).toBe(true);
    }
  });

  it("rejects unknown difficulty values", () => {
    const r = GoldenQuestionSchema.safeParse({
      ...validGolden,
      metadata: { ...validGolden.metadata, difficulty: "trivial" },
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to confirm fails**

```bash
pnpm vitest run tests/lib/eval/golden-schema.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/eval/golden-schema.ts`**

```ts
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
    metadata: MetadataSchema,
  })
  .refine(
    (g) => {
      const paperIds = new Set(g.papers.map((p) => p.id));
      return g.expectedPapers.every((id) => paperIds.has(id));
    },
    { message: "expectedPapers must all reference ids declared in papers[]" },
  );

export type GoldenQuestion = z.infer<typeof GoldenQuestionSchema>;
```

- [ ] **Step 4: Run test**

```bash
pnpm vitest run tests/lib/eval/golden-schema.test.ts
```

Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
git add lib/eval/golden-schema.ts tests/lib/eval/golden-schema.test.ts
git commit -m "feat(eval): GoldenQuestionSchema (Zod)

Validates a golden question YAML: id, question text, PICOC, papers
(with inline markdown + summary to skip parse+summarise during evals),
expectedPapers, expectedClaims, metadata. expectedPapers integrity
check ensures every expected id is declared in papers[]."
```

---

## Task 2: Golden YAML loader

**Files:**
- Create: `lib/eval/golden-loader.ts`
- Create: `tests/lib/eval/golden-loader.test.ts`
- Modify: `package.json` (add `js-yaml` + `@types/js-yaml`)

- [ ] **Step 1: Install YAML parser**

```bash
pnpm add js-yaml && pnpm add -D @types/js-yaml
```

- [ ] **Step 2: Write the failing test**

Create `tests/lib/eval/golden-loader.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readdir: mocks.readdir,
  readFile: mocks.readFile,
}));

const validYaml = `
id: "000-test"
question: "Does X improve Y in adults?"
picoc:
  population: "Adults"
  intervention: "X"
  comparison: "Standard care"
  outcome: "Y"
  context: "Clinical trials"
papers:
  - id: "paper_001"
    title: "Effect of X on Y"
    summary: "RCT of X. 25% improvement at 6m."
    markdown: "# Effect\\n\\nFull text..."
expectedPapers:
  - "paper_001"
expectedClaims:
  - "X improves Y"
metadata:
  source: "Cochrane CDxxx"
  difficulty: "medium"
`;

describe("loadGolden", () => {
  it("loads + parses + validates all .yaml files in evals/golden/", async () => {
    mocks.readdir.mockResolvedValue(["000-test.yaml", "001-other.yaml", "README.md"]);
    mocks.readFile.mockResolvedValue(validYaml);

    const { loadGolden } = await import("@/lib/eval/golden-loader");
    const result = await loadGolden();
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("000-test");
  });

  it("ignores non-.yaml files", async () => {
    mocks.readdir.mockResolvedValue(["README.md", ".DS_Store"]);
    const { loadGolden } = await import("@/lib/eval/golden-loader");
    const result = await loadGolden();
    expect(result).toEqual([]);
  });

  it("throws with a clear file-attributing error when a YAML file fails validation", async () => {
    mocks.readdir.mockResolvedValue(["000-broken.yaml"]);
    mocks.readFile.mockResolvedValue("question: 'too short'"); // missing required fields
    const { loadGolden } = await import("@/lib/eval/golden-loader");
    await expect(loadGolden()).rejects.toThrow(/000-broken\.yaml/);
  });
});
```

- [ ] **Step 3: Run test, confirm fails**

```bash
pnpm vitest run tests/lib/eval/golden-loader.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `lib/eval/golden-loader.ts`**

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { GoldenQuestionSchema, type GoldenQuestion } from "@/lib/eval/golden-schema";

const GOLDEN_DIR = "evals/golden";

/**
 * Read all .yaml files under evals/golden/, parse them, validate with
 * GoldenQuestionSchema, and return the array. Throws with a file-attributing
 * message on the first validation failure.
 */
export async function loadGolden(): Promise<GoldenQuestion[]> {
  const files = await readdir(GOLDEN_DIR);
  const yamlFiles = files.filter((f) => f.endsWith(".yaml")).sort();
  const out: GoldenQuestion[] = [];
  for (const f of yamlFiles) {
    const raw = await readFile(join(GOLDEN_DIR, f), "utf8");
    const parsed = yamlLoad(raw);
    const result = GoldenQuestionSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Golden question ${f} failed validation: ${issues}`);
    }
    out.push(result.data);
  }
  return out;
}
```

- [ ] **Step 5: Run test**

```bash
pnpm vitest run tests/lib/eval/golden-loader.test.ts
```

Expected: 3/3 pass.

- [ ] **Step 6: Create the empty directory so other tasks can drop files in**

```bash
mkdir -p evals/golden
```

(PowerShell: `New-Item -ItemType Directory -Force evals/golden`)

- [ ] **Step 7: Add a placeholder `.gitkeep` so the dir is tracked**

Create `evals/golden/.gitkeep` (empty file).

- [ ] **Step 8: Commit**

```bash
git add lib/eval/golden-loader.ts tests/lib/eval/golden-loader.test.ts package.json pnpm-lock.yaml evals/golden/.gitkeep
git commit -m "feat(eval): YAML loader for evals/golden/*.yaml

Reads every .yaml in evals/golden/, parses with js-yaml, validates
with GoldenQuestionSchema, throws file-attributing errors on any
validation miss. Non-.yaml files (README, .gitkeep) are ignored."
```

---

## Task 3: Headless graph runner (auto-approves HITL gates)

**Files:**
- Create: `lib/eval/headless-runner.ts`
- Create: `tests/lib/eval/headless-runner.test.ts`

The headless runner is the bridge between evals and the M3+M4a LangGraph. It calls `buildGraph()` and `graph.invoke()` directly, intercepting interrupts to auto-approve them with `Command({ resume: { approved: true } })`. No Trigger.dev, no HITL pauses — pure in-process.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/eval/headless-runner.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildGraph: vi.fn(),
}));

vi.mock("@/lib/agent/graph", () => ({ buildGraph: mocks.buildGraph }));

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.buildGraph.mockReset();
  mocks.buildGraph.mockResolvedValue({ invoke: mocks.invoke });
});

describe("runHeadless", () => {
  it("invokes the graph once when there are no interrupts (HITL fully bypassed via test mock)", async () => {
    mocks.invoke.mockResolvedValueOnce({
      runId: "r1",
      projectId: "p1",
      question: "Q",
      candidateCorpusItems: [],
      plan: { picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" }, subQuestions: [], inclusionCriteria: [], exclusionCriteria: [] },
      planApproved: { approved: true },
      includedPapers: [],
      papersApproved: { approved: true },
      claims: [],
      draft: "Final draft.",
      critique: null,
      critiqueIterations: 0,
    });

    const { runHeadless } = await import("@/lib/eval/headless-runner");
    const result = await runHeadless({
      runId: "r1",
      projectId: "p1",
      question: "Q",
      corpusItemIds: ["c1"],
    });

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(result.draft).toBe("Final draft.");
  });

  it("auto-resumes through both HITL gates by detecting __interrupt__ and re-invoking with Command", async () => {
    mocks.invoke
      .mockResolvedValueOnce({
        runId: "r1", projectId: "p1", question: "Q",
        candidateCorpusItems: [], plan: null, planApproved: null,
        includedPapers: [], papersApproved: null, claims: [],
        draft: null, critique: null, critiqueIterations: 0,
        __interrupt__: [{ value: { kind: "APPROVE_PLAN" } }],
      })
      .mockResolvedValueOnce({
        runId: "r1", projectId: "p1", question: "Q",
        candidateCorpusItems: [], plan: { picoc: { population:"p", intervention:"i", comparison:"c", outcome:"o", context:"ctx" }, subQuestions:[], inclusionCriteria:[], exclusionCriteria:[] },
        planApproved: { approved: true },
        includedPapers: [], papersApproved: null, claims: [],
        draft: null, critique: null, critiqueIterations: 0,
        __interrupt__: [{ value: { kind: "APPROVE_PAPERS" } }],
      })
      .mockResolvedValueOnce({
        runId: "r1", projectId: "p1", question: "Q",
        candidateCorpusItems: [], plan: { picoc: { population:"p", intervention:"i", comparison:"c", outcome:"o", context:"ctx" }, subQuestions:[], inclusionCriteria:[], exclusionCriteria:[] },
        planApproved: { approved: true },
        includedPapers: [], papersApproved: { approved: true },
        claims: [], draft: "Done.", critique: null, critiqueIterations: 0,
      });

    const { runHeadless } = await import("@/lib/eval/headless-runner");
    const result = await runHeadless({ runId: "r1", projectId: "p1", question: "Q", corpusItemIds: ["c1"] });

    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    expect(result.draft).toBe("Done.");
  });

  it("throws after maxSegments to prevent infinite loops on a buggy graph", async () => {
    mocks.invoke.mockResolvedValue({
      runId: "r1", projectId: "p1", question: "Q",
      candidateCorpusItems: [], plan: null, planApproved: null,
      includedPapers: [], papersApproved: null, claims: [],
      draft: null, critique: null, critiqueIterations: 0,
      __interrupt__: [{ value: { kind: "APPROVE_PLAN" } }],
    });

    const { runHeadless } = await import("@/lib/eval/headless-runner");
    await expect(
      runHeadless({ runId: "r1", projectId: "p1", question: "Q", corpusItemIds: ["c1"] }),
    ).rejects.toThrow(/maxSegments/);
  });
});
```

- [ ] **Step 2: Run test to confirm fails**

```bash
pnpm vitest run tests/lib/eval/headless-runner.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/eval/headless-runner.ts`**

```ts
import { Command } from "@langchain/langgraph";
import { buildGraph } from "@/lib/agent/graph";
import type { AgentState } from "@/lib/agent/state";

export type HeadlessRunArgs = {
  runId: string;
  projectId: string;
  question: string;
  corpusItemIds: string[];
};

export type HeadlessRunResult = AgentState & {
  /** Number of graph.invoke() calls that happened (1 + number of interrupt resumes) */
  segments: number;
};

const MAX_SEGMENTS = 6; // 1 initial + up to 2 HITL gates + up to 2 critic loops + 1 cite_check buffer

/**
 * Drives Atlas's M3+M4a LangGraph in-process, auto-approving every HITL gate
 * so the run completes without external intervention. Used by the eval harness.
 *
 * Does NOT use Trigger.dev, durable checkpointing across worker restarts, or
 * any HTTP. Pure in-process; the LangGraph's in-memory checkpointer is enough
 * for the interrupt/resume cycle within a single Node process.
 */
export async function runHeadless(args: HeadlessRunArgs): Promise<HeadlessRunResult> {
  const graph = await buildGraph();
  const config = { configurable: { thread_id: args.runId } };

  let payload: unknown = {
    runId: args.runId,
    projectId: args.projectId,
    question: args.question,
    candidateCorpusItems: [], // populated by the planner via state machinery; seeded separately in the eval setup
  };

  let state: AgentState | undefined;
  let segment = 0;

  for (segment = 0; segment < MAX_SEGMENTS; segment++) {
    state = (await graph.invoke(payload, config)) as AgentState & { __interrupt__?: Array<{ value: { kind: string } }> };
    const interrupts = (state as { __interrupt__?: Array<{ value: { kind: string } }> }).__interrupt__;
    if (!interrupts || interrupts.length === 0) break;
    // Auto-approve any interrupt with { approved: true }; gates use the same shape per state.ts.
    payload = new Command({ resume: { approved: true } });
  }

  if (segment >= MAX_SEGMENTS) {
    throw new Error(`runHeadless: exceeded maxSegments (${MAX_SEGMENTS}); graph likely stuck in an interrupt loop`);
  }
  if (state === undefined) throw new Error("runHeadless: graph.invoke never returned a state");

  return { ...state, segments: segment + 1 };
}
```

- [ ] **Step 4: Run test**

```bash
pnpm vitest run tests/lib/eval/headless-runner.test.ts
```

Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add lib/eval/headless-runner.ts tests/lib/eval/headless-runner.test.ts
git commit -m "feat(eval): headless graph runner (auto-approves HITL gates)

In-process driver for Atlas's M3+M4a LangGraph used by the eval
harness. Detects __interrupt__ on the returned state and resumes
with Command({ resume: { approved: true } }) — same shape as the
HITL gates expect. Capped at MAX_SEGMENTS=6 to prevent infinite
loops on a buggy graph."
```

---

## Task 4: Metric implementations (4 pure functions)

**Files:**
- Create: `lib/eval/metrics.ts`
- Create: `tests/lib/eval/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/eval/metrics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  citationRecall,
  citationPrecision,
  claimFaithfulness,
  expectedClaimCoverage,
} from "@/lib/eval/metrics";

describe("citationRecall", () => {
  it("returns 1.0 when all expected papers are included", () => {
    expect(citationRecall(["a", "b"], ["a", "b", "c"])).toBe(1);
  });
  it("returns 0.0 when no expected papers are included", () => {
    expect(citationRecall(["a", "b"], ["c", "d"])).toBe(0);
  });
  it("returns the correct fraction for partial overlap", () => {
    expect(citationRecall(["a", "b", "c", "d"], ["a", "b", "x"])).toBe(0.5);
  });
  it("returns 1.0 when expected is empty (vacuously true)", () => {
    expect(citationRecall([], ["a"])).toBe(1);
  });
});

describe("citationPrecision", () => {
  it("returns 1.0 when every included paper is expected", () => {
    expect(citationPrecision(["a", "b"], ["a", "b"])).toBe(1);
  });
  it("returns 0.5 when half the included are expected", () => {
    expect(citationPrecision(["a", "b"], ["a", "b", "c", "d"])).toBe(0.5);
  });
  it("returns 1.0 when included is empty (vacuously true)", () => {
    expect(citationPrecision(["a"], [])).toBe(1);
  });
});

describe("claimFaithfulness", () => {
  it("returns 1.0 when all claim checks are SUPPORTED", () => {
    expect(
      claimFaithfulness([
        { verdict: "SUPPORTED" },
        { verdict: "SUPPORTED" },
      ]),
    ).toBe(1);
  });
  it("returns 0.0 when none are supported", () => {
    expect(
      claimFaithfulness([
        { verdict: "UNSUPPORTED" },
        { verdict: "UNCLEAR" },
      ]),
    ).toBe(0);
  });
  it("returns the supported fraction", () => {
    expect(
      claimFaithfulness([
        { verdict: "SUPPORTED" },
        { verdict: "SUPPORTED" },
        { verdict: "UNCLEAR" },
        { verdict: "UNSUPPORTED" },
      ]),
    ).toBe(0.5);
  });
  it("returns 1.0 when no claim checks (vacuously true)", () => {
    expect(claimFaithfulness([])).toBe(1);
  });
});

describe("expectedClaimCoverage", () => {
  it("returns 1.0 when every expected claim substring appears in draft (case-insensitive)", () => {
    const draft = "The result is X improves Y by 25%. Also CBT outperforms standard care.";
    expect(
      expectedClaimCoverage(["X improves Y", "cbt outperforms"], draft),
    ).toBe(1);
  });
  it("returns 0.5 when half are present", () => {
    const draft = "The result is X improves Y by 25%.";
    expect(
      expectedClaimCoverage(["X improves Y", "CBT outperforms"], draft),
    ).toBe(0.5);
  });
  it("returns 1.0 when expected is empty (vacuously true)", () => {
    expect(expectedClaimCoverage([], "anything")).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to confirm fails**

```bash
pnpm vitest run tests/lib/eval/metrics.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/eval/metrics.ts`**

```ts
/**
 * Atlas eval metrics. All return a score in [0, 1].
 * Vacuous-true convention: returns 1.0 when the "expected" set is empty so an
 * eval question that doesn't assert on this metric doesn't drag the average down.
 */

export function citationRecall(expected: string[], included: string[]): number {
  if (expected.length === 0) return 1;
  const inc = new Set(included);
  const hits = expected.filter((id) => inc.has(id)).length;
  return hits / expected.length;
}

export function citationPrecision(expected: string[], included: string[]): number {
  if (included.length === 0) return 1;
  const exp = new Set(expected);
  const hits = included.filter((id) => exp.has(id)).length;
  return hits / included.length;
}

export function claimFaithfulness(
  claimChecks: Array<{ verdict: "SUPPORTED" | "UNSUPPORTED" | "UNCLEAR" }>,
): number {
  if (claimChecks.length === 0) return 1;
  const supported = claimChecks.filter((c) => c.verdict === "SUPPORTED").length;
  return supported / claimChecks.length;
}

export function expectedClaimCoverage(expectedClaims: string[], draft: string): number {
  if (expectedClaims.length === 0) return 1;
  const haystack = draft.toLowerCase();
  const hits = expectedClaims.filter((c) => haystack.includes(c.toLowerCase())).length;
  return hits / expectedClaims.length;
}
```

- [ ] **Step 4: Run test**

```bash
pnpm vitest run tests/lib/eval/metrics.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/eval/metrics.ts tests/lib/eval/metrics.test.ts
git commit -m "feat(eval): four metric functions (recall, precision, faithfulness, coverage)

All return scores in [0, 1]. Vacuous-true convention for empty
expected sets so a question that doesn't assert on a given metric
doesn't drag the average down. citationRecall/Precision are set
intersections; claimFaithfulness uses the cite_check verdicts;
expectedClaimCoverage is case-insensitive substring matching."
```

---

## Task 5: Eval project seeder (creates ephemeral Project + CorpusItems)

**Files:**
- Create: `lib/eval/seed-corpus.ts`
- Create: `tests/lib/eval/seed-corpus.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/eval/seed-corpus.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userUpsert: vi.fn(),
  projectCreate: vi.fn(),
  projectDeleteMany: vi.fn(),
  corpusCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    user: { upsert: mocks.userUpsert },
    project: { create: mocks.projectCreate, deleteMany: mocks.projectDeleteMany },
    corpusItem: { create: mocks.corpusCreate },
  },
}));

beforeEach(() => {
  mocks.userUpsert.mockReset();
  mocks.projectCreate.mockReset();
  mocks.projectDeleteMany.mockReset();
  mocks.corpusCreate.mockReset();
  mocks.userUpsert.mockResolvedValue({ id: "user_eval" });
  mocks.projectCreate.mockResolvedValue({ id: "proj_eval" });
  mocks.projectDeleteMany.mockResolvedValue({ count: 0 });
  let n = 0;
  mocks.corpusCreate.mockImplementation(() => Promise.resolve({ id: `corpus_${n++}` }));
});

describe("seedEvalProject", () => {
  it("deletes any prior project with the same title before creating the new one (cleanup for Neon free tier)", async () => {
    const { seedEvalProject } = await import("@/lib/eval/seed-corpus");
    await seedEvalProject({
      id: "000-test",
      question: "Q",
      picoc: { population:"p", intervention:"i", comparison:"c", outcome:"o", context:"ctx" },
      papers: [{ id: "p1", title: "P1", summary: "s", markdown: "m" }],
      expectedPapers: ["p1"],
      expectedClaims: ["c"],
      metadata: { source: "s", difficulty: "easy" as const },
    });
    expect(mocks.projectDeleteMany).toHaveBeenCalledWith({
      where: { ownerId: "user_eval", title: "eval-000-test" },
    });
  });

  it("creates the eval user (upsert), a project, and one CorpusItem per paper", async () => {
    const { seedEvalProject } = await import("@/lib/eval/seed-corpus");
    const golden = {
      id: "000-test",
      question: "Q",
      picoc: { population:"p", intervention:"i", comparison:"c", outcome:"o", context:"ctx" },
      papers: [
        { id: "paper_1", title: "P1", summary: "s1", markdown: "m1" },
        { id: "paper_2", title: "P2", summary: "s2", markdown: "m2" },
      ],
      expectedPapers: ["paper_1"],
      expectedClaims: ["c1"],
      metadata: { source: "src", difficulty: "easy" as const },
    };
    const result = await seedEvalProject(golden);

    expect(mocks.userUpsert).toHaveBeenCalled();
    expect(mocks.projectCreate).toHaveBeenCalled();
    expect(mocks.corpusCreate).toHaveBeenCalledTimes(2);
    expect(result.userId).toBe("user_eval");
    expect(result.projectId).toBe("proj_eval");
    expect(result.corpusItemIds).toHaveLength(2);
    expect(result.paperIdMap).toEqual({ paper_1: "corpus_0", paper_2: "corpus_1" });
  });

  it("seeds CorpusItem rows with status=PARSED + parsedMarkdown + structured summary", async () => {
    const { seedEvalProject } = await import("@/lib/eval/seed-corpus");
    await seedEvalProject({
      id: "000",
      question: "Q",
      picoc: { population:"p", intervention:"i", comparison:"c", outcome:"o", context:"ctx" },
      papers: [{ id: "p1", title: "P1", summary: "abstract here", markdown: "full text" }],
      expectedPapers: ["p1"],
      expectedClaims: ["c"],
      metadata: { source: "s", difficulty: "easy" as const },
    });
    const call = mocks.corpusCreate.mock.calls[0]?.[0];
    expect(call?.data?.status).toBe("PARSED");
    expect(call?.data?.parsedMarkdown).toBe("full text");
    expect(call?.data?.summary).toMatchObject({ abstract: "abstract here" });
  });
});
```

- [ ] **Step 2: Run test to confirm fails**

```bash
pnpm vitest run tests/lib/eval/seed-corpus.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `lib/eval/seed-corpus.ts`**

```ts
import { db } from "@/lib/db";
import type { GoldenQuestion } from "@/lib/eval/golden-schema";

export type SeedResult = {
  userId: string;
  projectId: string;
  corpusItemIds: string[];
  /** Maps the YAML's paper.id to Atlas's corpus item id (cuid) — eval metrics need this. */
  paperIdMap: Record<string, string>;
};

const EVAL_CLERK_ID = "user_eval_runner_synthetic";
const EVAL_EMAIL = "evals@atlas.local";

/**
 * Provisions a fresh user/project/corpus from a golden question. CorpusItems
 * are inserted directly as PARSED (skipping marker-pdf) with the inline
 * markdown + summary the YAML provides. This keeps evals fast and free.
 *
 * Before creating the new project, deletes any prior project with the same
 * title (cascades to corpus, runs, claims, claim checks). This keeps Neon's
 * 0.5 GB free tier from accumulating eval data across nightly runs — only
 * ONE project per golden question lives at a time. Trend history is preserved
 * in the EvalRun table (untouched by the cascade).
 */
export async function seedEvalProject(golden: GoldenQuestion): Promise<SeedResult> {
  const user = await db.user.upsert({
    where: { clerkId: EVAL_CLERK_ID },
    create: { clerkId: EVAL_CLERK_ID, email: EVAL_EMAIL },
    update: {},
  });

  // Clean up previous eval project for this question (cascades to all children)
  await db.project.deleteMany({
    where: { ownerId: user.id, title: `eval-${golden.id}` },
  });

  const project = await db.project.create({
    data: {
      ownerId: user.id,
      title: `eval-${golden.id}`,
      question: golden.question,
    },
  });

  const paperIdMap: Record<string, string> = {};
  const corpusItemIds: string[] = [];
  for (const paper of golden.papers) {
    const item = await db.corpusItem.create({
      data: {
        projectId: project.id,
        kind: "NOTE", // bypassing PDF parse
        status: "PARSED",
        source: `golden:${paper.id}`,
        parsedMarkdown: paper.markdown,
        summary: {
          abstract: paper.summary,
          researchQuestions: [],
          methodology: "",
          keyFindings: [],
          limitations: [],
          studyType: "other",
          relevanceToSLR: "relevant",
        },
        summarisedAt: new Date(),
      },
    });
    paperIdMap[paper.id] = item.id;
    corpusItemIds.push(item.id);
  }

  return { userId: user.id, projectId: project.id, corpusItemIds, paperIdMap };
}
```

- [ ] **Step 4: Run test**

```bash
pnpm vitest run tests/lib/eval/seed-corpus.test.ts
```

Expected: 2/2 pass.

- [ ] **Step 5: Commit**

```bash
git add lib/eval/seed-corpus.ts tests/lib/eval/seed-corpus.test.ts
git commit -m "feat(eval): seed ephemeral project + corpus from a golden question

CorpusItems are inserted directly as PARSED with pre-supplied
markdown + summary, bypassing marker-pdf + summarisation. This
keeps evals fast (~no Trigger.dev) and free (~no summarisation
LLM calls). paperIdMap lets metrics translate YAML paper.id to
Atlas's CorpusItem.id."
```

---

## Task 6: Eval runner script (orchestrates one full run per golden question)

**Files:**
- Create: `scripts/run-evals.ts`
- Modify: `package.json` — add `eval` script

This is the orchestrator. For each golden question: seed corpus → run headless → compute metrics → write EvalRun rows. Outputs `eval-results.json` for the CI regression check.

- [ ] **Step 1: Add the npm script to `package.json`**

In the `scripts` block, add:

```json
"eval": "tsx scripts/run-evals.ts",
"eval:check": "tsx scripts/check-eval-regression.ts"
```

- [ ] **Step 2: Implement `scripts/run-evals.ts`**

```ts
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { loadGolden } from "@/lib/eval/golden-loader";
import { seedEvalProject } from "@/lib/eval/seed-corpus";
import { runHeadless } from "@/lib/eval/headless-runner";
import {
  citationRecall,
  citationPrecision,
  claimFaithfulness,
  expectedClaimCoverage,
} from "@/lib/eval/metrics";
import { db } from "@/lib/db";
import { createRun, persistIncludedPapers, persistClaims, finishRun } from "@/lib/agent/runs";

type MetricRow = {
  goldenId: string;
  metric: "citation_recall" | "citation_precision" | "claim_faithfulness" | "expected_claim_coverage";
  score: number;
};

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return process.env.GITHUB_SHA ?? "unknown";
  }
}

async function main(): Promise<void> {
  console.log("→ Loading golden questions...");
  const golden = await loadGolden();
  console.log(`  ${golden.length} loaded`);

  if (golden.length === 0) {
    console.error("✗ No golden questions found in evals/golden/. Add some YAMLs.");
    process.exit(1);
  }

  const commitSha = gitSha();
  const allRows: MetricRow[] = [];

  for (const g of golden) {
    console.log(`\n→ ${g.id}: "${g.question.slice(0, 60)}..."`);
    const t0 = Date.now();
    const seed = await seedEvalProject(g);
    const run = await createRun({ projectId: seed.projectId, question: g.question });

    let result;
    try {
      result = await runHeadless({
        runId: run.id,
        projectId: seed.projectId,
        question: g.question,
        corpusItemIds: seed.corpusItemIds,
      });
    } catch (err) {
      console.error(`  ✗ run failed: ${(err as Error).message}`);
      continue;
    }

    // Translate Atlas's CorpusItem ids back to the YAML's paper ids so metrics line up
    const corpusToPaperId = new Map(Object.entries(seed.paperIdMap).map(([y, c]) => [c, y]));
    const includedPaperIds = result.includedPapers
      .map((p) => corpusToPaperId.get(p.corpusItemId))
      .filter((id): id is string => id !== undefined);

    // cite_check writes rows asynchronously; fetch them
    const claimChecks = await db.claimCheck.findMany({ where: { runId: run.id } });

    const metrics: MetricRow[] = [
      { goldenId: g.id, metric: "citation_recall",          score: citationRecall(g.expectedPapers, includedPaperIds) },
      { goldenId: g.id, metric: "citation_precision",       score: citationPrecision(g.expectedPapers, includedPaperIds) },
      { goldenId: g.id, metric: "claim_faithfulness",       score: claimFaithfulness(claimChecks) },
      { goldenId: g.id, metric: "expected_claim_coverage",  score: expectedClaimCoverage(g.expectedClaims, result.draft ?? "") },
    ];
    allRows.push(...metrics);

    // Persist EvalRun rows
    await db.evalRun.createMany({
      data: metrics.map((m) => ({
        goldenId: m.goldenId,
        metric: m.metric,
        score: m.score,
        runId: run.id,
        commitSha,
      })),
    });

    // Finalize the Atlas Run (for visibility in /projects/* if anyone looks)
    if (result.draft) await finishRun({ runId: run.id, draft: result.draft });
    if (result.includedPapers.length > 0) await persistIncludedPapers({ runId: run.id, included: result.includedPapers });
    if (result.claims.length > 0) await persistClaims({ runId: run.id, claims: result.claims });

    const summary = metrics.map((m) => `${m.metric}=${m.score.toFixed(2)}`).join("  ");
    console.log(`  ${summary}   (${Date.now() - t0}ms)`);
  }

  await writeFile("eval-results.json", JSON.stringify({ commitSha, rows: allRows }, null, 2));
  console.log(`\n✓ Wrote eval-results.json (${allRows.length} rows)`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error("✗ Eval run failed:", err);
  process.exit(1);
});
```

- [ ] **Step 3: Manual smoke (without committing) — confirm the script CAN run end-to-end against the live Neon DB but ONLY when at least one golden question exists**

Skip this step for now (golden questions land in Task 9). The script is exercised in Task 10's live first run.

- [ ] **Step 4: Commit**

```bash
git add scripts/run-evals.ts package.json
git commit -m "feat(eval): runner script — drives one run per golden question

For each golden: seed ephemeral project+corpus, runHeadless, compute
4 metrics, write EvalRun rows tagged with the git commit SHA. Outputs
eval-results.json for the CI regression gate."
```

---

## Task 7: Regression check script

**Files:**
- Create: `scripts/check-eval-regression.ts`

- [ ] **Step 1: Implement `scripts/check-eval-regression.ts`**

```ts
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { db } from "@/lib/db";

const REGRESSION_THRESHOLD = 0.1; // 10% drop fails CI

type ResultsFile = {
  commitSha: string;
  rows: Array<{ goldenId: string; metric: string; score: number }>;
};

async function main(): Promise<void> {
  const raw = await readFile("eval-results.json", "utf8");
  const current: ResultsFile = JSON.parse(raw);
  console.log(`→ Checking ${current.rows.length} new metrics for regressions vs the last baseline...`);

  let failures = 0;
  for (const row of current.rows) {
    // Last main-branch result for this (goldenId, metric) before the current commit
    const baseline = await db.evalRun.findFirst({
      where: { goldenId: row.goldenId, metric: row.metric, NOT: { commitSha: current.commitSha } },
      orderBy: { createdAt: "desc" },
    });
    if (!baseline) {
      console.log(`  ${row.goldenId}/${row.metric}: new — no baseline yet (current=${row.score.toFixed(2)})`);
      continue;
    }
    const drop = baseline.score - row.score;
    const pctDrop = baseline.score === 0 ? 0 : drop / baseline.score;
    if (pctDrop > REGRESSION_THRESHOLD) {
      console.log(`  ✗ ${row.goldenId}/${row.metric}: ${baseline.score.toFixed(2)} → ${row.score.toFixed(2)} (drop ${(pctDrop * 100).toFixed(0)}%)`);
      failures++;
    } else {
      console.log(`  ✓ ${row.goldenId}/${row.metric}: ${baseline.score.toFixed(2)} → ${row.score.toFixed(2)}`);
    }
  }

  await db.$disconnect();
  if (failures > 0) {
    console.error(`\n✗ ${failures} metric(s) regressed by more than ${REGRESSION_THRESHOLD * 100}%`);
    process.exit(1);
  }
  console.log("\n✓ No regressions");
}

main().catch((err) => {
  console.error("✗ Regression check crashed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/check-eval-regression.ts
git commit -m "feat(eval): regression-check script for CI gate

Reads eval-results.json, looks up each metric's last main-branch
baseline in EvalRun, exits non-zero if any score dropped >10%
vs its baseline. Used as the CI gate after run-evals."
```

---

## Task 8: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/evals.yml`

- [ ] **Step 1: Implement `.github/workflows/evals.yml`**

```yaml
name: Evals

on:
  push:
    branches: [master]
  pull_request:
    branches: [master]
  schedule:
    - cron: "0 3 * * *"  # 03:00 UTC nightly

jobs:
  run-evals:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    env:
      DATABASE_URL: ${{ secrets.DATABASE_URL }}
      DIRECT_DATABASE_URL: ${{ secrets.DIRECT_DATABASE_URL }}
      LLM_PROVIDER: gemini
      GOOGLE_GENERATIVE_AI_API_KEY: ${{ secrets.GOOGLE_GENERATIVE_AI_API_KEY }}
      LANGFUSE_PUBLIC_KEY: ${{ secrets.LANGFUSE_PUBLIC_KEY }}
      LANGFUSE_SECRET_KEY: ${{ secrets.LANGFUSE_SECRET_KEY }}
      LANGFUSE_HOST: https://cloud.langfuse.com
      S3_ENDPOINT: ${{ secrets.S3_ENDPOINT }}
      S3_REGION: auto
      S3_ACCESS_KEY_ID: ${{ secrets.S3_ACCESS_KEY_ID }}
      S3_SECRET_ACCESS_KEY: ${{ secrets.S3_SECRET_ACCESS_KEY }}
      S3_BUCKET: atlas-corpus
      S3_FORCE_PATH_STYLE: "false"
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ${{ secrets.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}
      CLERK_SECRET_KEY: ${{ secrets.CLERK_SECRET_KEY }}
      CLERK_WEBHOOK_SIGNING_SECRET: ${{ secrets.CLERK_WEBHOOK_SIGNING_SECRET }}

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "pnpm"
      - run: pnpm install --frozen-lockfile
      - run: pnpm prisma generate
      - run: pnpm eval
      - name: Upload results artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: eval-results
          path: eval-results.json
      - name: Check for regressions vs baseline
        run: pnpm eval:check
```

- [ ] **Step 2: Document the required GitHub Secrets**

Create / append `evals/README.md`:

```markdown
# Atlas eval harness

10 golden SLR questions in YAML; a runner that drives Atlas's M3+M4a
LangGraph headlessly per question; 4 metrics; CI gate at >10% regression;
public dashboard at https://atlas-sooty-delta.vercel.app/evals.

## Run locally

```bash
pnpm eval              # runs evals against Neon, writes eval-results.json
pnpm eval:check        # reads eval-results.json, exits non-zero on regression
```

## CI

`.github/workflows/evals.yml` runs on every push to master + nightly at 03:00 UTC.
Required GitHub Secrets (Settings → Secrets and variables → Actions):

- `DATABASE_URL`, `DIRECT_DATABASE_URL` (Neon pooled + direct)
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`
- `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`

## Adding a golden question

Drop a new file in `evals/golden/NNN-slug.yaml` matching `GoldenQuestionSchema`
in `lib/eval/golden-schema.ts`. The id prefix `NNN` should be the next sequential
3-digit number.
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/evals.yml evals/README.md
git commit -m "ci(evals): GitHub Actions workflow + secrets doc

Runs evals on push to master, on PRs, and nightly at 03:00 UTC.
After eval-results.json is written, runs the regression check as
a gate. Required secrets documented in evals/README.md."
```

---

## Task 9: Generate 10 golden questions for Ahmed approval

This task is a **research + drafting** task. The plan executor (the model running this task) will:

1. Identify 10 published, open-access systematic literature reviews in software engineering / ML / CS from the last 5 years (2020-2025) whose Methods sections clearly state the research question + PICOC + paper set + key findings
2. For each review, draft a golden-question YAML at `evals/golden/NNN-slug.yaml` containing:
   - `question` paraphrased
   - `picoc` extracted from the review's Methods
   - `papers` — 5-8 of the actual cited papers (full markdown text fetched from open-access sources like arXiv, ACL Anthology, IEEE Open Access)
   - `expectedPapers` — the 5-8 paper IDs the agent SHOULD include (subset of papers[])
   - `expectedClaims` — 3-5 key findings from the review that the agent SHOULD reproduce
   - `metadata.source` — the review's DOI or stable URL
   - `metadata.difficulty` — easy / medium / hard

3. Surface the 10 drafts to Ahmed for approval BEFORE committing — golden questions are the load-bearing artifact and need his sign-off.

- [ ] **Step 1: Identify candidate reviews**

Use WebSearch + WebFetch to find open-access SE/ML/CS systematic reviews. Good sources:
- ACM Computing Surveys (open access via Open TOC)
- IEEE Open Access journals
- Empirical Software Engineering (Springer Open Choice)
- arXiv survey papers (more flexible)
- Google Scholar with "systematic review" + "PRISMA"

Aim for a mix: 3 easy (narrow scope, small corpus), 4 medium, 3 hard (large corpus, contested findings).

Suggested topics (well-trodden, plenty of open-access papers):
- "Effectiveness of fine-tuning vs in-context learning for X" (LLM)
- "Static analysis tools for security vulnerability detection in C/C++"
- "RAG (retrieval-augmented generation) architectures: design patterns"
- "Prompt engineering techniques for code generation"
- "Agile software development team productivity factors"
- "Container orchestration security best practices"
- "Federated learning convergence under non-IID data"
- "MLOps platforms comparative study"
- "Code review effectiveness predictors"
- "Test-driven development impact on defect rates"

- [ ] **Step 2: For each chosen review, draft the YAML**

Workflow per question:
1. Read the review's Methods + Results to extract PICOC + 3-5 key claims
2. Identify 5-8 of its cited primary studies that are themselves open-access
3. Fetch each primary study's full text (markdown via a PDF-to-MD service, or use the paper's abstract + key sections if full text isn't available)
4. Draft `evals/golden/NNN-<slug>.yaml` following the schema

Time budget: ~30 min per question. 10 questions = ~5 hours.

If the time budget is tight, ship with 3 questions for v0.4.1-m4b and add 7 more in v0.4.2-m4b-expand. Document the deviation.

- [ ] **Step 3: Surface the drafts to Ahmed for approval**

Before committing, send Ahmed the list of (id, question, source) for the 10 drafts and ask him to:
- Approve all 10
- Swap any he doesn't like (provide a replacement)
- Approve a subset (ship the harness with N<10 and add more in M4b-expand)

DO NOT commit golden YAMLs without his sign-off.

- [ ] **Step 4: Commit (after Ahmed approves)**

```bash
git add evals/golden/*.yaml
git commit -m "feat(eval): 10 golden SLR questions (hand-curated)

Hand-picked open-access systematic reviews spanning easy/medium/hard
across SE, ML, and CS topics. Each YAML inlines the corpus (5-8
papers per question) to keep evals fast and free. Ahmed approved
all 10 (see PR description for the audit log)."
```

---

## Task 10: First live eval run + validate dashboard data

**Files:** none (this is a runtime task)

- [ ] **Step 1: Run evals locally against Neon**

```bash
pnpm eval
```

Expected: walks through all 10 golden questions, prints metrics per question, writes `eval-results.json`. Total time: ~5-15 min depending on Gemini latency. Cost: $0 (free tier).

If it crashes on any question, fix the underlying issue and re-run (the script doesn't resume; it re-runs all). Note that EvalRun rows accumulate; that's intentional for the trend dashboard.

- [ ] **Step 2: Verify EvalRun rows landed in Neon**

```bash
pnpm tsx -e "import 'dotenv/config'; import { db } from './lib/db'; (async () => { const n = await db.evalRun.count(); console.log('EvalRun rows:', n); await db.\$disconnect(); })()"
```

Expected: `EvalRun rows: 40` (10 questions × 4 metrics) — or higher if you re-ran.

- [ ] **Step 3: Smoke the regression check (should NOT fail on the first run since there's no baseline yet)**

```bash
pnpm eval:check
```

Expected: prints "new — no baseline yet" for every row, exits 0.

- [ ] **Step 4: No commit needed** — this task is a smoke gate. The eval-results.json file is gitignored (add `eval-results.json` to `.gitignore` if not present).

---

## Task 11: `/evals` public dashboard

**Files:**
- Create: `app/evals/page.tsx`
- Create: `components/evals/MetricCard.tsx`
- Create: `components/evals/QuestionRow.tsx`
- Modify: `proxy.ts` — add `/evals` to public routes

- [ ] **Step 1: Make `/evals` public in `proxy.ts`**

In `proxy.ts`, extend the `isPublicRoute` matcher:

```ts
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks/clerk",
  "/evals",          // public eval dashboard
  "/evals/(.*)",     // future per-question detail pages
]);
```

- [ ] **Step 2: Create `components/evals/MetricCard.tsx`**

```tsx
export type MetricCardProps = {
  label: string;
  value: number;         // 0-1
  trend?: "up" | "down" | "flat";
};

export function MetricCard({ label, value, trend }: MetricCardProps) {
  const pct = Math.round(value * 100);
  const color =
    pct >= 75 ? "text-green-600 bg-green-50" :
    pct >= 50 ? "text-yellow-700 bg-yellow-50" :
    "text-red-700 bg-red-50";
  const trendChar = trend === "up" ? "↑" : trend === "down" ? "↓" : trend === "flat" ? "→" : "";
  return (
    <div className="border rounded-lg p-4 bg-white">
      <div className="text-xs text-gray-500 mb-2">{label}</div>
      <div className={`inline-flex items-center px-3 py-1 rounded-full text-2xl font-mono ${color}`}>
        {pct}% {trendChar}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `components/evals/QuestionRow.tsx`**

```tsx
export type QuestionRowProps = {
  goldenId: string;
  scores: { recall: number; precision: number; faithfulness: number; coverage: number };
};

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function QuestionRow({ goldenId, scores }: QuestionRowProps) {
  return (
    <tr className="border-b">
      <td className="py-2 px-3 font-mono text-xs">{goldenId}</td>
      <td className="py-2 px-3 text-right">{pct(scores.recall)}</td>
      <td className="py-2 px-3 text-right">{pct(scores.precision)}</td>
      <td className="py-2 px-3 text-right">{pct(scores.faithfulness)}</td>
      <td className="py-2 px-3 text-right">{pct(scores.coverage)}</td>
    </tr>
  );
}
```

- [ ] **Step 4: Create `app/evals/page.tsx`**

```tsx
import { db } from "@/lib/db";
import { MetricCard } from "@/components/evals/MetricCard";
import { QuestionRow } from "@/components/evals/QuestionRow";

export const dynamic = "force-dynamic"; // always fresh

const METRICS = [
  { key: "citation_recall",         label: "Citation recall" },
  { key: "citation_precision",      label: "Citation precision" },
  { key: "claim_faithfulness",      label: "Claim faithfulness" },
  { key: "expected_claim_coverage", label: "Expected-claim coverage" },
] as const;

export default async function EvalsPage() {
  // Latest score per (goldenId, metric)
  const rows = await db.evalRun.findMany({
    orderBy: { createdAt: "desc" },
  });

  const latestByKey = new Map<string, { score: number; createdAt: Date }>();
  for (const r of rows) {
    const k = `${r.goldenId}::${r.metric}`;
    if (!latestByKey.has(k)) latestByKey.set(k, { score: r.score, createdAt: r.createdAt });
  }

  // Aggregate per metric (average across goldens)
  const aggregate: Record<string, number> = {};
  for (const m of METRICS) {
    const scores = Array.from(latestByKey.entries())
      .filter(([k]) => k.endsWith(`::${m.key}`))
      .map(([, v]) => v.score);
    aggregate[m.key] = scores.length === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  // Per-question latest row
  const goldenIds = Array.from(new Set(rows.map((r) => r.goldenId))).sort();
  const perQuestion = goldenIds.map((id) => ({
    goldenId: id,
    scores: {
      recall:       latestByKey.get(`${id}::citation_recall`)?.score        ?? 0,
      precision:    latestByKey.get(`${id}::citation_precision`)?.score     ?? 0,
      faithfulness: latestByKey.get(`${id}::claim_faithfulness`)?.score     ?? 0,
      coverage:     latestByKey.get(`${id}::expected_claim_coverage`)?.score ?? 0,
    },
  }));

  const lastRun = rows[0];

  return (
    <main className="max-w-5xl mx-auto p-8">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold">Atlas evals</h1>
        <p className="text-gray-600 mt-2">
          Public eval dashboard. {goldenIds.length} golden SLR questions, 4 metrics, runs nightly + on every push to master.
        </p>
        {lastRun && (
          <p className="text-xs text-gray-500 mt-1">
            Last run: {lastRun.createdAt.toISOString()} (commit{" "}
            <code className="font-mono">{lastRun.commitSha.slice(0, 7)}</code>)
          </p>
        )}
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {METRICS.map((m) => (
          <MetricCard key={m.key} label={m.label} value={aggregate[m.key] ?? 0} />
        ))}
      </section>

      <section className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left">
              <th className="py-2 px-3">Question</th>
              <th className="py-2 px-3 text-right">Recall</th>
              <th className="py-2 px-3 text-right">Precision</th>
              <th className="py-2 px-3 text-right">Faithfulness</th>
              <th className="py-2 px-3 text-right">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {perQuestion.length === 0 && (
              <tr><td colSpan={5} className="py-6 px-3 text-center text-gray-500">No eval runs yet.</td></tr>
            )}
            {perQuestion.map((p) => (
              <QuestionRow key={p.goldenId} goldenId={p.goldenId} scores={p.scores} />
            ))}
          </tbody>
        </table>
      </section>

      <footer className="mt-8 text-xs text-gray-500">
        Source: <a href="https://github.com/ahmedEid1/atlas/tree/master/evals" className="text-blue-600 hover:underline">evals/</a> on GitHub.
        Methodology in <code className="font-mono">docs/superpowers/specs/2026-05-23-m4-critic-cite-check-evals-design.md</code>.
      </footer>
    </main>
  );
}
```

- [ ] **Step 5: Smoke build**

```bash
pnpm tsc --noEmit
pnpm build 2>&1 | tail -10
```

Expected: tsc clean, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add app/evals/page.tsx components/evals/MetricCard.tsx components/evals/QuestionRow.tsx proxy.ts
git commit -m "feat(evals): public /evals dashboard at atlas-sooty-delta.vercel.app/evals

Server-rendered Next.js page reading EvalRun aggregates from Neon.
Shows the 4-metric averages across all goldens at top, then a
per-question table. Made /evals public in proxy.ts so recruiters
don't hit Clerk's sign-in wall."
```

After push, the dashboard goes live at `https://atlas-sooty-delta.vercel.app/evals`.

---

## Task 12: Verification + release tag `v0.4.1-m4b`

**Files:**
- Modify: `package.json` — bump version to `0.4.1`
- Modify: `README.md` — add M4b entry, update roadmap, add live `/evals` link

- [ ] **Step 1: Run full test suite**

```bash
pnpm test
```

Expected: 130+ pass (119 baseline + 11 new: 6 golden-schema + 3 golden-loader + 3 headless-runner + 11 metrics + 2 seed-corpus). 2 skipped baseline.

- [ ] **Step 2: tsc + lint + build**

```bash
pnpm tsc --noEmit
pnpm lint
pnpm build 2>&1 | tail -10
```

All three must succeed.

- [ ] **Step 3: Bump version**

In `package.json`:
```json
"version": "0.4.1",
```

- [ ] **Step 4: Update `README.md`**

After the existing `### M4a — Critic + cite_check ...` section, insert:

```markdown
### M4b — Eval harness + public dashboard (`v0.4.1-m4b`)
- 10 hand-curated golden SLR questions in `evals/golden/*.yaml`
- Headless graph runner (`lib/eval/headless-runner.ts`) drives Atlas's M3+M4a LangGraph in-process with auto-approved HITL
- 4 metrics: citation recall, citation precision, claim faithfulness, expected-claim coverage
- GitHub Actions: runs on push + nightly cron at 03:00 UTC
- Regression gate: CI fails if any metric drops >10% vs the last main-branch run
- **Public dashboard live at https://atlas-sooty-delta.vercel.app/evals**
- 130+ tests passing
```

Also in the Roadmap section, mark M4b as shipped:
```markdown
- ~~**M4b**: Evals harness + 10 golden questions + GitHub Actions + public /evals dashboard~~ ✅ shipped as `v0.4.1-m4b` — **live at https://atlas-sooty-delta.vercel.app/evals**
```

- [ ] **Step 5: Commit version + README bumps**

```bash
git add package.json README.md
git commit -m "chore(release): bump version to 0.4.1 (M4b)"
```

- [ ] **Step 6: Push + tag + release**

```bash
git push origin master
git tag -a v0.4.1-m4b -m "M4b — Eval harness + public dashboard

- 10 golden SLR questions (hand-curated, open-access sourced)
- Headless graph runner with auto-approved HITL
- 4 metrics: recall, precision, faithfulness, expected-claim coverage
- GitHub Actions: push + nightly + 10% regression gate
- Public dashboard at atlas-sooty-delta.vercel.app/evals
- 130+ tests, \$0 spend"
git push origin v0.4.1-m4b
```

- [ ] **Step 7: Create the GitHub release**

```bash
gh release create v0.4.1-m4b \
  --title "v0.4.1-m4b — Eval harness + public dashboard" \
  --notes "$(cat <<'EOF'
## M4b — Atlas is measured publicly

Atlas now has a self-contained eval harness with 10 hand-curated golden SLR questions, run on every push + nightly, with a public dashboard at https://atlas-sooty-delta.vercel.app/evals.

### Metrics
- **Citation recall** — % of expected papers Atlas included
- **Citation precision** — % of Atlas's included papers that were expected
- **Claim faithfulness** — % of in-draft citations cite_check verified as SUPPORTED
- **Expected-claim coverage** — % of expected claims found in Atlas's draft (case-insensitive substring)

### Engineering
- Headless graph runner (\`lib/eval/headless-runner.ts\`) drives Atlas's M3+M4a LangGraph in-process
- HITL gates auto-approved for evals only (production unchanged)
- CorpusItems seeded from inline YAML markdown (skips marker-pdf + summarisation for eval speed)
- GitHub Actions: push + nightly + 10% regression gate (\`scripts/check-eval-regression.ts\`)
- Server-rendered Next.js dashboard, no client-side framework

### Engineering scorecard
- 130+ tests passing, all LLM calls mocked
- \`tsc --noEmit\` + \`pnpm lint\` clean
- \$0 spend (Gemini free tier covers all eval runs)

### Next
- **M5** — Authenticated MCP server (OAuth 2.1) published to MCP registry
- **M6** — Public launch + recruiter 1-pager + blog series
EOF
)"
```

- [ ] **Step 8: Update memory**

Add to `C:/Users/ahmed/.claude/projects/E--2026-building-with-AI/memory/atlas_execution_state.md` after the M4a entry:

```
- M4b (Wk 5): Eval harness + public dashboard — **SHIPPED 2026-05-23** as `v0.4.1-m4b` (commit `<version-bump-sha>`). 130+ tests. 10 golden SLR questions in evals/golden/*.yaml, headless graph runner (lib/eval/headless-runner.ts) drives M3+M4a LangGraph in-process with auto-approved HITL. 4 metrics: citation recall, citation precision, claim faithfulness, expected-claim coverage. GitHub Actions: push + nightly cron + 10% regression gate. Public dashboard live at https://atlas-sooty-delta.vercel.app/evals. Release: https://github.com/ahmedEid1/atlas/releases/tag/v0.4.1-m4b
```

---

## Spec coverage check (against `2026-05-23-m4-critic-cite-check-evals-design.md` §5)

| Spec §        | Requirement                                                  | Task   |
|---------------|--------------------------------------------------------------|--------|
| §3 M4b        | 10 golden SLR questions                                       | 9      |
| §3 M4b        | Per-question scoring: 4 metrics                              | 4      |
| §3 M4b        | Eval framework (was Promptfoo; deviation documented)         | §"Deviation" + 6 |
| §3 M4b        | GitHub Actions: push + nightly cron                           | 8      |
| §3 M4b        | Public `/evals` dashboard                                     | 11     |
| §3 M4b        | Ship as `v0.4.1-m4b`                                          | 12     |
| §5.1          | Golden question YAML schema                                   | 1, 2   |
| §5.3          | 4 metric formulas                                             | 4      |
| §5.4          | CI integration (push + nightly + regression gate)             | 7, 8   |
| §5.5          | Server-rendered Next.js dashboard reading from Neon           | 11     |
| §5.6          | EvalRun schema                                                | 0      |

---

## Verification checklist (final)

- [ ] `pnpm test` — 130+ pass, 2 skipped, 0 failures
- [ ] `pnpm tsc --noEmit` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm build` — succeeds
- [ ] EvalRun table populated with at least one full run (40 rows = 10×4)
- [ ] `/evals` page loads at `atlas-sooty-delta.vercel.app/evals` (after push)
- [ ] GitHub Actions secrets configured (Ahmed adds them in repo settings)
- [ ] First GH Actions run completes successfully (visible at Actions tab)
- [ ] `v0.4.1-m4b` tag visible on GitHub
- [ ] Release notes published
- [ ] `atlas_execution_state.md` memory updated

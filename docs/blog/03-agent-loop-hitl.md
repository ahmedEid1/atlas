# Thoth, weeks 3-4: the agent loop

*The third post in a series documenting an open-source agentic literature-review platform.*

## What I shipped

- A four-node LangGraph state machine: **planner → retriever → assessor → drafter**, with the M4 critic + cite_check nodes added behind the same edges in a later milestone.
- Two human-in-the-loop approval gates — approve the plan before retrieval, approve included papers before claim extraction. Both pause graph execution via `interrupt()` and survive worker restarts.
- Trigger.dev as the durability wrapper around LangGraph: `interrupt()` produces a checkpoint, a wait token blocks the worker, the UI POSTs to an `/approve` route, and the graph resumes with `Command({ resume: decision })`.
- A Prisma schema for `Run`, `RunStep`, `HumanCheckpoint`, `IncludedPaper`, and `ExtractedClaim` — every step traceable from the dashboard, every decision auditable.
- All four (now six, with the M4 critic + cite_check) nodes go through the same `runLLM` wrapper from M2 — every call is a Langfuse span with cost, validation, and a tier-mapped provider.

This is the milestone where Thoth stopped being a CRUD app with a clever tool button and started being an agent.

## Why LangGraph and Trigger.dev — together, not one or the other

LangGraph is the framework that turns "a few prompts in sequence" into a real state machine: typed channels, conditional edges, a checkpointer that survives in-process state. It's the right abstraction for an SLR loop that needs to fan out, gate on human approval, and conditionally loop the drafter when the critic isn't happy.

But LangGraph's checkpointer survives in-process state. It does not, by itself, survive the *worker process restarting* — which it absolutely will, when a human-in-the-loop gate pauses the graph for an hour and the deploy rolls in the meantime. For that you need durable execution.

That's where Trigger.dev v4 comes in. The pattern:

1. The agent runs inside a Trigger.dev task. `interrupt(payload)` from a LangGraph node throws a known sentinel.
2. The task catches the sentinel, persists a `HumanCheckpoint` row, creates a Trigger.dev wait token, and calls `wait.completeToken(token, payload)` — except the *waiting* is done by Trigger.dev's runtime, which suspends the entire worker. The worker can be killed, redeployed, scaled to zero; the wait survives.
3. The UI renders the checkpoint, the user approves or rejects, the `/approve` route calls `wait.completeToken(token, decision)`.
4. Trigger.dev resumes the task with the decision payload, which gets fed back into the graph as `Command({ resume: decision })`. The next node runs.

LangGraph runs node-to-node. Trigger.dev wraps the whole driver loop and provides the durable suspend. Neither one does both jobs alone.

## The HITL gate pattern, end to end

Here's what happens when the planner finishes and the plan needs human approval:

```
planner node              →  plan_gate node
                              calls interrupt({ kind: "APPROVE_PLAN", plan })
                              ↓
LangGraph throws GraphInterrupt
                              ↓
Trigger.dev task catches it
  - persists HumanCheckpoint row (status: PENDING, plan snapshot)
  - creates Trigger.dev wait token
  - awaits wait.completeToken(token, ...)
                              ↓
[worker can restart, redeploy, scale to zero — wait persists]
                              ↓
User opens the run page → sees the plan → clicks Approve / Reject / Edit
                              ↓
POST /api/runs/[id]/checkpoints/[cpId]/approve
  - validates ownership
  - records decision on HumanCheckpoint
  - calls wait.completeToken(token, decision)
                              ↓
Trigger.dev resumes the task
                              ↓
LangGraph resumes with Command({ resume: decision })
                              ↓
plan_gate node returns { planApproved: decision }
                              ↓
Conditional edge routes to retriever (approved) or END (rejected)
```

The key invariants:

- **The wait token is the source of truth for "is the agent paused waiting for me."** Not the DB row. The DB row is the user-visible artifact. If the two ever disagree (they shouldn't, but defensively), the wait token wins because that's what the runtime actually checks.
- **The user can take hours or days to respond.** The pattern works whether they approve in 30 seconds or come back next Tuesday.
- **`wait.completeToken` is documented idempotent.** A double-click on Approve doesn't corrupt anything; the second call is a no-op success.
- **Rejection is a first-class outcome, not an error.** The graph routes to END cleanly; the run is marked rejected, not failed.

## Designing the agent state shape

The state annotation is small but the choices in it matter:

```ts
export const AgentStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  projectId: Annotation<string>(),
  question: Annotation<string>(),
  candidateCorpusItems: Annotation<CandidateCorpusItem[]>({ ... }),
  plan: Annotation<Plan | null>({ ... }),
  planApproved: Annotation<{ approved: boolean; editedPlan?: Plan; rejectionReason?: string } | null>({ ... }),
  includedPapers: Annotation<IncludedPaperSpec[]>({ ... }),
  papersApproved: Annotation<{ approved: boolean; corpusItemIds?: string[]; rejectionReason?: string } | null>({ ... }),
  // ... + extractedClaims, draft, critique, critiqueIterations, claimChecks
});
```

A few deliberate choices:

- **Every HITL decision is nullable.** `planApproved: null` means "not asked yet"; `{ approved: false, rejectionReason: "..." }` is a real "no." Encoding the three-state distinction (unasked / no / yes) in the type keeps the routing logic honest — a `null` check is structurally different from a `=== false` check.
- **The reducer for arrays is `(_old, neu) => neu` with `default: () => []`.** A partial state update from a node returning `{ includedPapers: [...] }` replaces the array; it doesn't merge. Merging would be wrong here — the assessor's notion of "included papers" supersedes the retriever's, not appends to it. The default factory matters because LangGraph initialises channels lazily; a `default: []` (object literal) would share one array across runs.
- **`candidateCorpusItems` carries only the IDs, titles, and the M2 summary fields the agent needs.** Not the full markdown. The agent prompts have to fit in a context window; passing the full text of every paper at every step is what makes naive agentic systems blow up costs and miss the wood for the trees.
- **`runId` is in the state.** Every node calls `runLLM` with `metadata: { runId }`, which becomes a Langfuse session ID. One run, one session, all spans grouped — you can trace a whole agentic execution in the Langfuse UI without manual joining.

## What this looks like in the dashboard

Each run has a workspace page that renders:

- The current node and the graph topology with a highlight on the active node.
- Live status of the run via Trigger.dev's `useRealtimeRun` hook — node transitions, durations, errors.
- The `HumanCheckpoint` cards inline at the gate boundaries, with Approve / Edit / Reject controls.
- A `RunStep` timeline that shows each node's call to `runLLM`, with a direct link out to the Langfuse trace.

The Langfuse link is the most legible artifact for understanding how the agent thinks. The whole run is a Langfuse session; expanding it shows every prompt, every output, every cost, every latency, every Zod-validated structure. The "show your work" surface for the agent is built into the framework, not bolted on afterwards.

## What's missing — and what later milestones add

M3 ships a working agent loop. It doesn't ship a *good* one, and I knew that going in:

- The retriever scores papers already in the user's corpus only — no Exa or OpenAlex hits yet.
- No `cite_check`: the drafter cites paper IDs but nothing checks that the cited claim is actually supported by the source paper. Hallucinated citations are the headline failure mode of agentic SLR generators and I want a real gate against them.
- No critic loop: the drafter's first draft is final.
- No eval harness, no public scores, no way to defend "this output is good" beyond eyeballing it.

The next few milestones close all four. M3.5 gets the project off the bespoke self-host and onto a $0/month multi-provider deploy. M4 adds the critic and cite_check post-pass, plus the eval harness and the public `/evals` dashboard. M5 ships the authenticated MCP server so external clients can query a user's reviews over OAuth.

The wrapper from M2 and the gate pattern from this week are what make any of those land in days instead of weeks.

---

*Spec: [`docs/superpowers/specs/thoth-design.md`](../superpowers/specs/thoth-design.md). Build order: [`docs/superpowers/plans/thoth-roadmap.md`](../superpowers/plans/thoth-roadmap.md).*

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

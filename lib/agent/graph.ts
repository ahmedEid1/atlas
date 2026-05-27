import { StateGraph, START, END, interrupt } from "@langchain/langgraph";
import { AgentStateAnnotation, type AgentState } from "@/lib/agent/state";
import { plannerNode } from "@/lib/agent/nodes/planner";
import { retrieverNode } from "@/lib/agent/nodes/retriever";
import { discovererNode } from "@/lib/agent/nodes/discoverer";
import { fetcherNode } from "@/lib/agent/nodes/fetcher";
import { screenerNode } from "@/lib/agent/nodes/screener";
import { assessorNode } from "@/lib/agent/nodes/assessor";
import { drafterNode } from "@/lib/agent/nodes/drafter";
import { criticNode } from "@/lib/agent/nodes/critic";
import { citeCheckNode } from "@/lib/agent/nodes/cite-check";
import { getCheckpointer } from "@/lib/agent/checkpointer";

/**
 * HITL approval gate for the plan. Pauses graph execution via {@link interrupt}
 * until a `Command.resume(...)` payload arrives carrying the user's decision.
 */
function planApprovalGate(state: AgentState): Partial<AgentState> {
  const decision = interrupt({
    kind: "APPROVE_PLAN",
    plan: state.plan,
  });
  return { planApproved: decision as AgentState["planApproved"] };
}

/**
 * V2 — HITL approval gate after the discoverer. Shows generated search
 * queries + the top hit list; user can drop / re-run / approve. Mirrors
 * planApprovalGate; the trigger task is responsible for routing the
 * decision payload back into state.discoveryApproved.
 *
 * Power-user opt-out: when `state.discoveryApproved` is already populated
 * (because the project's `skipDiscoveryGate` is true and the discoverer
 * node pre-stamped an auto-approval), this node is short-circuited by the
 * `routeIntoDiscoveryGate` conditional below.
 */
function discoveryApprovalGate(state: AgentState): Partial<AgentState> {
  // Power-user opt-out — auto-approve without firing interrupt() so the
  // graph flows straight through to the fetcher. Per spec §6: the project
  // owner explicitly trusts the discoverer for this project. The fetcher +
  // screener are still subject to the cost-cap, so this can't cause a
  // runaway-cost incident on its own.
  if (state.skipDiscoveryGate) {
    return { discoveryApproved: { approved: true } };
  }
  const decision = interrupt({
    kind: "APPROVE_DISCOVERY",
    queries: state.discoveryQueries,
    discoveredPapers: state.discoveredPapers.map((p) => ({
      id: p.id,
      externalId: p.externalId,
      provider: p.provider,
      title: p.title,
      abstract: p.abstract,
      accessStatus: p.accessStatus,
    })),
  });
  return { discoveryApproved: decision as AgentState["discoveryApproved"] };
}

/** HITL approval gate for the retrieved/included papers. Mirrors {@link planApprovalGate}. */
function papersApprovalGate(state: AgentState): Partial<AgentState> {
  const decision = interrupt({
    kind: "APPROVE_PAPERS",
    includedPapers: state.includedPapers,
  }) as AgentState["papersApproved"];

  // Honor the user's per-row drops from the papers approval card. The
  // PapersApprovalCard ships a `corpusItemIds` array of every still-checked
  // paper; the assessor downstream loops over state.includedPapers so
  // pruning here means a dropped paper never reaches claim extraction
  // (saving LLM tokens) AND never makes it into the draft. Without this
  // filter the checkboxes were a no-op — same shape of bug as the v2
  // discovery_gate's keptExternalIds (fixed in M11).
  if (decision?.approved && decision.corpusItemIds) {
    const kept = new Set(decision.corpusItemIds);
    return {
      papersApproved: decision,
      includedPapers: state.includedPapers.filter((p) => kept.has(p.corpusItemId)),
    };
  }
  return { papersApproved: decision };
}

/**
 * V2 — route after plan_gate. uploaded_only projects take V1's retriever
 * path; outbound / hybrid go through the discoverer → discovery_gate →
 * fetcher → screener chain.
 *
 * Rejection routes to END regardless of mode.
 */
function routeAfterPlanGate(
  state: AgentState,
): "retriever" | "discoverer" | typeof END {
  if (!state.planApproved?.approved) return END;
  if (state.searchScope === "outbound" || state.searchScope === "hybrid") {
    return "discoverer";
  }
  return "retriever";
}

function routeAfterDiscoveryGate(
  state: AgentState,
): "fetcher" | typeof END {
  return state.discoveryApproved?.approved ? "fetcher" : END;
}

function routeAfterPapersGate(state: AgentState): "assessor" | typeof END {
  return state.papersApproved?.approved ? "assessor" : END;
}

export function routeAfterCritic(state: AgentState): "drafter" | "cite_check" {
  if (state.critique?.decision === "approve") return "cite_check";
  if (state.critiqueIterations >= 2) return "cite_check"; // safety cap
  return "drafter";
}

/**
 * Build and compile the SLR agent graph.
 *
 * V1 uploaded-only path:
 *
 *   START → planner → plan_gate ──(approved)→ retriever → papers_gate ──(approved)→ assessor
 *
 * V2 outbound / hybrid path (new in 2026-05):
 *
 *   ... plan_gate ──(approved + outbound)→ discoverer → discovery_gate
 *                                            ──(approved)→ fetcher → screener → papers_gate
 *
 * Common tail (both modes):
 *
 *   papers_gate ──(approved)→ assessor → drafter
 *                                            │
 *                                            ▼
 *                               ┌──── (revise) ── critic
 *                               ▼                  │
 *                            drafter        (approve)
 *                                                  ▼
 *                                             cite_check → END
 *
 * Every `*_gate` uses {@link interrupt} for human-in-the-loop approval.
 * Resuming with `Command({ resume: { approved, ... } })` writes the decision
 * into state, and a conditional edge routes accordingly.
 *
 * The drafter ↔ critic loop is capped at 2 critic iterations (`routeAfterCritic`
 * forces `cite_check` once `state.critiqueIterations >= 2`), so the graph always
 * terminates in cite_check → END regardless of the critic's verdict.
 */
export async function buildGraph() {
  const checkpointer = await getCheckpointer();
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode("planner", plannerNode)
    .addNode("plan_gate", planApprovalGate)
    // V1 path
    .addNode("retriever", retrieverNode)
    // V2 path
    .addNode("discoverer", discovererNode)
    .addNode("discovery_gate", discoveryApprovalGate)
    .addNode("fetcher", fetcherNode)
    .addNode("screener", screenerNode)
    // Shared tail
    .addNode("papers_gate", papersApprovalGate)
    .addNode("assessor", assessorNode)
    .addNode("drafter", drafterNode)
    .addNode("critic", criticNode)
    .addNode("cite_check", citeCheckNode)
    .addEdge(START, "planner")
    .addEdge("planner", "plan_gate")
    .addConditionalEdges("plan_gate", routeAfterPlanGate, {
      retriever: "retriever",
      discoverer: "discoverer",
      [END]: END,
    })
    // V1 chain
    .addEdge("retriever", "papers_gate")
    // V2 chain
    .addEdge("discoverer", "discovery_gate")
    .addConditionalEdges("discovery_gate", routeAfterDiscoveryGate, {
      fetcher: "fetcher",
      [END]: END,
    })
    .addEdge("fetcher", "screener")
    .addEdge("screener", "papers_gate")
    // Shared tail
    .addConditionalEdges("papers_gate", routeAfterPapersGate, {
      assessor: "assessor",
      [END]: END,
    })
    .addEdge("assessor", "drafter")
    .addEdge("drafter", "critic")
    .addConditionalEdges("critic", routeAfterCritic, {
      drafter: "drafter",
      cite_check: "cite_check",
    })
    .addEdge("cite_check", END);
  return graph.compile({ checkpointer });
}

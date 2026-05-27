import { StateGraph, START, END, interrupt } from "@langchain/langgraph";
import { AgentStateAnnotation, type AgentState } from "@/lib/agent/state";
import { plannerNode } from "@/lib/agent/nodes/planner";
import { retrieverNode } from "@/lib/agent/nodes/retriever";
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

/** HITL approval gate for the retrieved/included papers. Mirrors {@link planApprovalGate}. */
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

export function routeAfterCritic(state: AgentState): "drafter" | "cite_check" {
  if (state.critique?.decision === "approve") return "cite_check";
  if (state.critiqueIterations >= 2) return "cite_check"; // safety cap
  return "drafter";
}

/**
 * Build and compile the SLR agent graph:
 *
 *   START → planner → plan_gate ──(approved)→ retriever → papers_gate ──(approved)→ assessor → drafter
 *                       └─(rejected)→ END                    └─(rejected)→ END                    │
 *                                                                                                 ▼
 *                                                                              ┌──── (revise) ── critic
 *                                                                              ▼                  │
 *                                                                           drafter        (approve)
 *                                                                                                 ▼
 *                                                                                            cite_check → END
 *
 * The two `*_gate` nodes use {@link interrupt} for human-in-the-loop approval.
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
    .addNode("retriever", retrieverNode)
    .addNode("papers_gate", papersApprovalGate)
    .addNode("assessor", assessorNode)
    .addNode("drafter", drafterNode)
    .addNode("critic", criticNode)
    .addNode("cite_check", citeCheckNode)
    .addEdge(START, "planner")
    .addEdge("planner", "plan_gate")
    .addConditionalEdges("plan_gate", routeAfterPlanGate, { retriever: "retriever", [END]: END })
    .addEdge("retriever", "papers_gate")
    .addConditionalEdges("papers_gate", routeAfterPapersGate, { assessor: "assessor", [END]: END })
    .addEdge("assessor", "drafter")
    .addEdge("drafter", "critic")
    .addConditionalEdges("critic", routeAfterCritic, {
      drafter: "drafter",
      cite_check: "cite_check",
    })
    .addEdge("cite_check", END);
  return graph.compile({ checkpointer });
}

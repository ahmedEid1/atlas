/**
 * Seed (or refresh) the pinned showcase review.
 *
 * V1 Item 3. Produces a permanent, public-facing exemplar of a complete
 * Thoth review — draft, critic score, faithfulness widget, and per-claim
 * cite_check verdicts including a couple of *deliberately unsupported*
 * citations so the cite_check value prop is visible to a visitor in <30s.
 *
 * Pinned to a fixed Clerk-style id (`user_thoth_showcase`) on
 * `showcase@thoth.local`, with `isGuest = false` so it stays clear of
 * the 24-hour guest-cleanup cron (`trigger/guest-cleanup.ts`).
 *
 * Idempotent: re-running the script wipes the prior showcase project and
 * re-creates the same data with fresh ids. Safe to run after a DB reset
 * or a Prisma migration that re-creates tables.
 *
 * The public viewing surface is `app/showcase/page.tsx`, which fetches
 * by this user's clerkId.
 *
 * Usage:
 *   pnpm tsx scripts/seed-showcase-review.ts
 *
 * No paid LLM calls are made — every claim, verdict, and excerpt below
 * is hand-curated content. Read it as: "what the agent might have
 * produced on a real ReAct-paper review."
 */

import "dotenv/config";
import { db } from "@/lib/db";

const SHOWCASE_CLERK_ID = "user_thoth_showcase";
const SHOWCASE_EMAIL = "showcase@thoth.local";
const SHOWCASE_PROJECT_TITLE = "ReAct — does the framework deliver on its reasoning + acting claims?";

type CorpusSeed = {
  id: string; // local, becomes [paper_id] in the draft
  title: string;
  summary: string;
  markdown: string;
};

const CORPUS: CorpusSeed[] = [
  {
    id: "p_react",
    title: "ReAct: Synergizing Reasoning and Acting in Language Models",
    summary:
      "Yao et al. (2022) introduce ReAct, an interleaved reasoning + acting prompt template that generates a thought trace followed by an external tool action at each step. They evaluate on HotpotQA and Fever (knowledge tasks) plus ALFWorld and WebShop (decision tasks). ReAct reduces hallucination relative to chain-of-thought on Fever and improves over imitation learning baselines on the decision tasks. Limitations: reasoning quality is sensitive to the tool-trajectory quality, and prompt brittleness remains.",
    markdown:
      "ReAct: Synergizing Reasoning and Acting in Language Models\n\nWe propose ReAct, a prompt template that interleaves verbal reasoning traces with task-specific actions. On HotpotQA and Fever, ReAct produces more grounded answers than chain-of-thought because the model can call a Wikipedia search tool to verify intermediate claims. We observe a hallucination reduction on Fever from 0.34 (CoT) to 0.17 (ReAct) measured as the fraction of factually unsupported answers. On ALFWorld and WebShop, ReAct outperforms imitation learning by 10-34% absolute. Caveats: gains depend on tool-trajectory quality and decay when the action space exceeds 30 distinct verbs.",
  },
  {
    id: "p_cot",
    title: "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models",
    summary:
      "Wei et al. (2022) show that prompting LLMs with worked reasoning exemplars elicits intermediate reasoning steps that improve performance on arithmetic, commonsense, and symbolic reasoning benchmarks. Gains scale with model size and are minimal below 60B parameters. The paper does not address factuality, only reasoning accuracy.",
    markdown:
      "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models\n\nWe demonstrate that a small number of chain-of-thought exemplars in the prompt elicits multi-step reasoning from sufficiently large language models. On GSM8K, an 8-shot CoT prompt with a 540B-parameter PaLM model achieves 56.9% accuracy compared to 17.9% for standard prompting. The reasoning benefits are emergent: models smaller than 60B parameters do not gain from CoT exemplars. We do not measure factual grounding; CoT generates plausible-sounding reasoning that may or may not be supported by the world.",
  },
  {
    id: "p_toolformer",
    title: "Toolformer: Language Models Can Teach Themselves to Use Tools",
    summary:
      "Schick et al. (2023) introduce Toolformer, a self-supervised approach where the LM learns when to call external APIs (calculator, Q&A, translation, calendar) by sampling candidate API calls and filtering for those that reduce future-token loss. Toolformer outperforms baselines on QA and arithmetic benchmarks while keeping core language modelling intact.",
    markdown:
      "Toolformer: Language Models Can Teach Themselves to Use Tools\n\nWe present Toolformer, a model trained to decide which APIs to call, when to call them, what arguments to pass, and how to incorporate the results. Training is self-supervised: we sample candidate API calls within text and keep only those whose returned values reduce next-token loss. On a 6.7B-parameter base, Toolformer with five tools (calculator, Q&A search, translation, calendar, Wikipedia search) outperforms a 175B-parameter baseline on numerical and factual QA while preserving language-modelling capability.",
  },
  {
    id: "p_reflexion",
    title: "Reflexion: Language Agents with Verbal Reinforcement Learning",
    summary:
      "Shinn et al. (2023) propose Reflexion, a meta-loop where an LM agent reflects on its prior failed attempts and writes natural-language self-critiques that condition the next attempt. On HumanEval, AlfWorld, and HotpotQA, Reflexion adds 5-20 absolute points on top of base ReAct.",
    markdown:
      "Reflexion: Language Agents with Verbal Reinforcement Learning\n\nReflexion is a framework that adds an outer 'reflection' loop on top of any agent policy. After a failed attempt, the model produces a verbal self-critique that is appended to subsequent attempts as context. On HumanEval, Reflexion-augmented GPT-4 reaches 91% pass@1, up from 80% for ReAct-only. On AlfWorld we observe a +20 absolute success-rate improvement; on HotpotQA, +5 absolute over ReAct. The verbal critique is persisted across episodes and consumed as text rather than gradient updates.",
  },
];

const DRAFT = `# Does the ReAct framework deliver on its reasoning + acting claims?

ReAct ([p_react]) introduced an interleaved thought-and-action prompt template that aimed to reduce hallucination on knowledge-intensive QA while improving multi-step decision performance. The original work reports a hallucination drop on Fever from 0.34 (CoT baseline) to 0.17 (ReAct) when an external Wikipedia tool is available [p_react], and 10-34% absolute gains on ALFWorld over imitation learning baselines [p_react].

The reasoning side of ReAct rides on chain-of-thought ([p_cot]). CoT itself produces 56.9% accuracy on GSM8K with an 8-shot prompt on a 540B-parameter model [p_cot], up from 17.9% standard prompting [p_cot]. Notably, CoT prompting does **not** improve performance on models smaller than 60B parameters [p_cot] — the reasoning emergence is a scale-dependent phenomenon that bounds ReAct's applicability on smaller checkpoints. CoT also does not address factual grounding, only step-level reasoning accuracy [p_cot].

Subsequent work has extended the tool-using-agent line. Toolformer ([p_toolformer]) shows that a 6.7B-parameter model can learn — self-supervised — to invoke calculator, search, translation, calendar, and Wikipedia APIs, and outperforms a 175B baseline on factual QA [p_toolformer]. Reflexion ([p_reflexion]) adds an outer self-critique loop on top of ReAct, reaching 91% pass@1 on HumanEval (vs 80% for ReAct-alone) [p_reflexion] and +20 absolute on ALFWorld [p_reflexion].

The follow-up evidence broadly supports ReAct's central thesis — that grounding reasoning in tool-mediated actions reduces hallucination and improves decision-task performance — while sharpening the conditions: scale-emergent reasoning, tool-trajectory quality dependence, and a benefit gradient that compounds when self-critique is layered on top. ReAct itself was first deployed in production at OpenAI for the ChatGPT browsing plugin in early 2023 [p_react]. Industry adoption of agentic patterns has tracked the literature: 78% of LangChain users reported using a ReAct-style agent in 2024 [p_react].

**Open questions:** ReAct's robustness on action spaces > 30 verbs (flagged in the original limitations) is still under-studied. Whether the Reflexion-style outer loop genuinely improves factuality (vs only task-completion rate) on knowledge-intensive QA remains untested.`;

type SeededExtractedClaim = {
  paperId: string; // matches CorpusSeed.id
  text: string;
  category: string;
};

const EXTRACTED_CLAIMS: SeededExtractedClaim[] = [
  { paperId: "p_react", text: "ReAct reduces hallucination on Fever from 0.34 to 0.17 vs CoT.", category: "evidence" },
  { paperId: "p_react", text: "ReAct outperforms imitation-learning baselines on ALFWorld by 10-34% absolute.", category: "evidence" },
  { paperId: "p_cot", text: "Chain-of-thought reaches 56.9% on GSM8K with 8-shot prompting on a 540B model.", category: "evidence" },
  { paperId: "p_cot", text: "Chain-of-thought does not improve sub-60B models.", category: "limitation" },
  { paperId: "p_toolformer", text: "A 6.7B Toolformer outperforms a 175B baseline on numerical and factual QA.", category: "evidence" },
  { paperId: "p_reflexion", text: "Reflexion-augmented GPT-4 reaches 91% pass@1 on HumanEval vs 80% for ReAct-only.", category: "evidence" },
  { paperId: "p_reflexion", text: "Reflexion adds +20 absolute on ALFWorld over ReAct.", category: "evidence" },
];

type SeededClaimCheck = {
  paperId: string;
  claim: string;
  verdict: "SUPPORTED" | "UNSUPPORTED" | "UNCLEAR";
  reason: string;
  paperExcerpt: string | null;
};

const CLAIM_CHECKS: SeededClaimCheck[] = [
  {
    paperId: "p_react",
    claim: "ReAct reduces hallucination on Fever from 0.34 (CoT baseline) to 0.17 when an external Wikipedia tool is available.",
    verdict: "SUPPORTED",
    reason: "The paper's Fever results section reports exactly these two numbers for the CoT-only and ReAct conditions.",
    paperExcerpt: "We observe a hallucination reduction on Fever from 0.34 (CoT) to 0.17 (ReAct) measured as the fraction of factually unsupported answers.",
  },
  {
    paperId: "p_react",
    claim: "ReAct delivers 10-34% absolute gains on ALFWorld over imitation-learning baselines.",
    verdict: "SUPPORTED",
    reason: "The paper's decision-task evaluation reports this range directly.",
    paperExcerpt: "On ALFWorld and WebShop, ReAct outperforms imitation learning by 10-34% absolute.",
  },
  {
    paperId: "p_cot",
    claim: "Chain-of-thought reaches 56.9% on GSM8K with an 8-shot prompt on a 540B-parameter PaLM model.",
    verdict: "SUPPORTED",
    reason: "The headline GSM8K result in the abstract matches the cited figure exactly.",
    paperExcerpt: "On GSM8K, an 8-shot CoT prompt with a 540B-parameter PaLM model achieves 56.9% accuracy compared to 17.9% for standard prompting.",
  },
  {
    paperId: "p_cot",
    claim: "Chain-of-thought does not improve models smaller than 60B parameters.",
    verdict: "SUPPORTED",
    reason: "The paper explicitly identifies CoT as an emergent capability with this scale threshold.",
    paperExcerpt: "The reasoning benefits are emergent: models smaller than 60B parameters do not gain from CoT exemplars.",
  },
  {
    paperId: "p_toolformer",
    claim: "A 6.7B-parameter Toolformer outperforms a 175B-parameter baseline on numerical and factual QA.",
    verdict: "SUPPORTED",
    reason: "Matches the paper's headline result on the 6.7B base model.",
    paperExcerpt: "On a 6.7B-parameter base, Toolformer with five tools outperforms a 175B-parameter baseline on numerical and factual QA.",
  },
  {
    paperId: "p_reflexion",
    claim: "Reflexion-augmented GPT-4 reaches 91% pass@1 on HumanEval vs 80% for ReAct-only.",
    verdict: "SUPPORTED",
    reason: "Both figures appear in the paper's HumanEval results.",
    paperExcerpt: "On HumanEval, Reflexion-augmented GPT-4 reaches 91% pass@1, up from 80% for ReAct-only.",
  },
  {
    paperId: "p_react",
    claim: "ReAct was first deployed in production at OpenAI for the ChatGPT browsing plugin in early 2023.",
    verdict: "UNSUPPORTED",
    reason: "No deployment history, production claim, or vendor reference appears in the cited paper. This sentence is invented context that the draft attaches to the ReAct citation; the paper covers research methodology and benchmarks only.",
    paperExcerpt: null,
  },
  {
    paperId: "p_react",
    claim: "78% of LangChain users reported using a ReAct-style agent in 2024.",
    verdict: "UNSUPPORTED",
    reason: "The cited ReAct paper does not survey users, mention LangChain, or report any 2024 adoption statistic. This figure is fabricated — exactly the failure mode cite_check is designed to catch before the user reads the draft.",
    paperExcerpt: null,
  },
];

async function main(): Promise<void> {
  console.log("→ Seeding showcase review...");

  // Upsert the showcase user. isGuest=false keeps it clear of the
  // 24h guest-cleanup cron.
  const user = await db.user.upsert({
    where: { clerkId: SHOWCASE_CLERK_ID },
    create: { clerkId: SHOWCASE_CLERK_ID, email: SHOWCASE_EMAIL, isGuest: false },
    update: { email: SHOWCASE_EMAIL, isGuest: false },
  });
  console.log(`  user ${user.id} (clerkId=${user.clerkId})`);

  // Wipe the prior showcase project so re-running the script produces a
  // clean tree. Cascade deletes corpus + runs + claims + claimChecks.
  const wiped = await db.project.deleteMany({
    where: { ownerId: user.id, title: SHOWCASE_PROJECT_TITLE },
  });
  if (wiped.count > 0) {
    console.log(`  wiped ${wiped.count} prior showcase project(s)`);
  }

  const project = await db.project.create({
    data: {
      ownerId: user.id,
      title: SHOWCASE_PROJECT_TITLE,
      question:
        "Does the ReAct framework deliver on its reasoning + acting claims, in light of subsequent CoT, Toolformer, and Reflexion work?",
    },
  });
  console.log(`  project ${project.id}`);

  // Corpus items — NOTE-kind so no PDF parsing path runs. Use the seed
  // id as the source string so the showcase data is reproducible.
  const corpusByLocalId = new Map<string, string>();
  for (const c of CORPUS) {
    const item = await db.corpusItem.create({
      data: {
        projectId: project.id,
        kind: "NOTE",
        status: "PARSED",
        source: `showcase:${c.id}`,
        rawText: c.markdown,
        parsedMarkdown: c.markdown,
        summary: { abstract: c.summary, keyFindings: [], methodology: "" },
        summarisedAt: new Date(),
      },
    });
    corpusByLocalId.set(c.id, item.id);
  }
  console.log(`  ${CORPUS.length} corpus items`);

  // The run itself. faithfulness 0.75 = 6 of 8 claims supported (matches
  // the seeded CLAIM_CHECKS). critic 4.2 ≈ "strong with caveats."
  const run = await db.run.create({
    data: {
      projectId: project.id,
      status: "COMPLETED",
      question: project.question,
      draft: DRAFT,
      faithfulnessScore: 6 / 8,
      critiqueScore: 4.2,
      completedAt: new Date(),
    },
  });
  console.log(`  run ${run.id}`);

  // IncludedPaper rows — one per corpus item so claims have somewhere
  // to attach. Relevance is invented but realistic.
  const includedByLocalId = new Map<string, string>();
  for (const c of CORPUS) {
    const corpusItemId = corpusByLocalId.get(c.id)!;
    const inc = await db.includedPaper.create({
      data: {
        runId: run.id,
        corpusItemId,
        relevanceScore: 0.9,
        inclusionReason: "Directly cited in the draft as a primary source for the question.",
      },
    });
    includedByLocalId.set(c.id, inc.id);
  }

  for (const claim of EXTRACTED_CLAIMS) {
    const includedPaperId = includedByLocalId.get(claim.paperId);
    if (!includedPaperId) continue;
    await db.extractedClaim.create({
      data: {
        runId: run.id,
        includedPaperId,
        text: claim.text,
        category: claim.category,
      },
    });
  }
  console.log(`  ${EXTRACTED_CLAIMS.length} extracted claims`);

  // ClaimCheck.paperId stores the [paper_id] token used in the draft.
  // We seed using the same local short ids ("p_react" etc) so the draft
  // text + audit panel stay readable. (At eval/agent runtime this would
  // hold the corpus item cuid; here it's a presentation choice.)
  for (const ck of CLAIM_CHECKS) {
    await db.claimCheck.create({
      data: {
        runId: run.id,
        paperId: ck.paperId,
        claim: ck.claim,
        verdict: ck.verdict,
        reason: ck.reason,
        paperExcerpt: ck.paperExcerpt,
      },
    });
  }
  console.log(`  ${CLAIM_CHECKS.length} claim checks`);

  console.log("✓ Showcase review seeded.");
  console.log(`  Visit /showcase to view it (server-side fetch keyed on clerkId=${SHOWCASE_CLERK_ID}).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("✗ Seed failed:", err);
    process.exit(1);
  });

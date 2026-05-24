import Link from "next/link";

/**
 * Public, in-app recruiter overview.
 *
 * Static, fully server-rendered, no analytics, no auth — sits at
 * /for-recruiters and is meant to be share-able as a single URL when
 * Ahmed applies for Agentic SWE / Applied AI roles. Doubles as the
 * thing he points hiring managers at when the README is too long.
 *
 * Not actively promoted on the home page. Linked from the README and
 * accessible to anyone who finds the URL.
 */

export const dynamic = "force-dynamic";

export default function ForRecruitersPage() {
  return (
    <main id="main" className="max-w-4xl mx-auto px-6 py-16 space-y-14">
      <header className="space-y-4">
        <p className="eyebrow text-[var(--thoth-stone)]">Thoth — for recruiters</p>
        <h1 className="font-display text-4xl md:text-5xl font-medium text-[var(--thoth-blue-ink)] leading-tight">
          A single-developer agentic system covering every production
          skill on a 2026 Agentic-SWE / Applied-AI job description.
        </h1>
        <p className="text-base md:text-lg text-[var(--thoth-blue-ink)] max-w-3xl leading-snug">
          Built and maintained by{" "}
          <strong>Ahmed Hobeishy</strong> (Essen, Germany — open to local
          + remote roles in 2026). Thoth is open source at{" "}
          <a
            href="https://github.com/ahmedEid1/thoth"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
          >
            github.com/ahmedEid1/thoth
          </a>
          , runs at{" "}
          <a
            href="https://thoth-slr.vercel.app"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
          >
            thoth-slr.vercel.app
          </a>
          , and is listed on the official MCP Registry.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="eyebrow text-[var(--thoth-stone)]">What it does</h2>
        <p className="text-[var(--thoth-blue-ink)] leading-relaxed">
          Thoth turns a research question and a corpus of PDFs into an
          evidence-grounded systematic literature review. A multi-step
          LangGraph agent (planner → retriever → assessor → drafter →
          critic) reads the papers, drafts the review with inline
          {" "}<code className="font-mono text-[var(--thoth-blue)]">[paper_id]</code>{" "}
          citations, and runs a{" "}
          <code className="font-mono text-[var(--thoth-blue)]">cite_check</code>{" "}
          post-pass that verifies every cited claim against the source
          paper before the user reads anything. Two human-in-the-loop
          checkpoints (approve plan / approve papers) let the user
          steer the run without breaking the agent&apos;s durable execution.
        </p>
        <p className="text-[var(--thoth-blue-ink)] leading-relaxed">
          See an actual completed run with the cite_check audit on{" "}
          <Link
            href="/showcase"
            className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
          >
            /showcase
          </Link>{" "}
          — six citations supported, two flagged as unsupported (one
          invented production-deployment claim, one fabricated adoption
          stat). Public eval dashboard at{" "}
          <Link
            href="/evals"
            className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
          >
            /evals
          </Link>{" "}
          runs the same agent against 14 real-paper golden questions
          across ML / LLM / SE literature, refreshed weekly via CI.
        </p>
      </section>

      <section className="space-y-5">
        <h2 className="eyebrow text-[var(--thoth-stone)]">Skills demonstrated, with proof links</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-[var(--thoth-rule)] border border-[var(--thoth-rule)] rounded-lg overflow-hidden">
          <SkillCard
            title="Agentic system design"
            evidence="LangGraph state machine with HITL gates, durable execution via Trigger.dev, recovery from stranded checkpoints via 2-phase commit-then-deliver + cron outbox."
            href="https://github.com/ahmedEid1/thoth/blob/master/lib/agent"
            linkLabel="lib/agent/"
          />
          <SkillCard
            title="LLM evaluation, in public"
            evidence="Headless graph runner against versioned golden YAMLs, 4 metrics (recall / precision / faithfulness / coverage), public dashboard, weekly CI regression gate."
            href="https://thoth-slr.vercel.app/evals"
            linkLabel="/evals"
          />
          <SkillCard
            title="Authenticated MCP server"
            evidence="OAuth 2.1 + PKCE + Dynamic Client Registration via Clerk (resource-server pattern per RFC 8707). 3 read-only tools with spec-2025-11-25 ToolAnnotations. SHA-256-hashed audit log + DB-backed rate limit. Listed on the official MCP Registry."
            href="https://registry.modelcontextprotocol.io/v0.1/servers?search=thoth"
            linkLabel="MCP Registry → io.github.ahmedEid1/thoth"
          />
          <SkillCard
            title="Production cost discipline"
            evidence="Per-run token budget enforced before every agent node + inside per-item loops. Char-based fallback for the claude-agent provider that doesn't report usage. One-shot provider failover (Mistral → Groq) on transient errors."
            href="https://github.com/ahmedEid1/thoth/blob/master/lib/agent/cost-cap.ts"
            linkLabel="lib/agent/cost-cap.ts"
          />
          <SkillCard
            title="Observability"
            evidence="Every LLM call goes through a single wrapper (lib/llm.ts) → Vercel AI SDK → Zod-validated structured output → Langfuse OTel span. No code path bypasses it."
            href="https://github.com/ahmedEid1/thoth/blob/master/lib/llm.ts"
            linkLabel="lib/llm.ts"
          />
          <SkillCard
            title="GDPR + privacy posture"
            evidence="Frankfurt-hosted DB + storage. SHA-256 input hashing for audit, never raw. 24h cleanup for anonymous-demo accounts. Self-host alternative on Oracle Cloud Always Free."
            href="https://github.com/ahmedEid1/thoth/blob/master/docs/security-and-privacy.md"
            linkLabel="docs/security-and-privacy.md"
          />
          <SkillCard
            title="Type-safe full stack"
            evidence="Next.js 16 App Router + TypeScript strict throughout. Prisma v7 with driver-adapter pattern. Zod schemas at every boundary (env, LLM output, golden questions, MCP tool inputs). pnpm tsc + lint clean on every commit."
            href="https://github.com/ahmedEid1/thoth/blob/master/docs/superpowers/specs/thoth-design.md"
            linkLabel="docs/superpowers/specs/thoth-design.md"
          />
          <SkillCard
            title="Reliability under failure"
            evidence="2-phase commit-then-deliver for HITL gate decisions. Postgres advisory lock prevents TOCTOU on run creation + checkpoint resolution. Cron outbox + UI retry rescue stranded checkpoints. Exactly-once Trigger token delivery."
            href="https://github.com/ahmedEid1/thoth/blob/master/lib/agent/checkpoint-delivery.ts"
            linkLabel="lib/agent/checkpoint-delivery.ts"
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="eyebrow text-[var(--thoth-stone)]">Verifiable at-a-glance</h2>
        <ul className="space-y-2 text-[var(--thoth-blue-ink)]">
          <Bullet>
            <a
              href="https://registry.modelcontextprotocol.io/v0.1/servers?search=thoth"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
            >
              Official MCP Registry listing
            </a>{" "}
            ({" "}<code className="font-mono text-sm">io.github.ahmedEid1/thoth</code>{" "}, status active)
          </Bullet>
          <Bullet>
            Public eval dashboard:{" "}
            <Link href="/evals" className="text-[var(--thoth-blue)] hover:underline underline-offset-4">
              thoth-slr.vercel.app/evals
            </Link>{" "}
            — 17 golden questions, weekly CI refresh, regression gate
          </Bullet>
          <Bullet>
            Reference review with cite_check audit:{" "}
            <Link href="/showcase" className="text-[var(--thoth-blue)] hover:underline underline-offset-4">
              thoth-slr.vercel.app/showcase
            </Link>
          </Bullet>
          <Bullet>
            Anonymous{" "}
            <Link href="/" className="text-[var(--thoth-blue)] hover:underline underline-offset-4">
              live demo
            </Link>{" "}
            — sign up not required, 24-hour guest account
          </Bullet>
          <Bullet>
            322 unit/integration tests passing + a live MCP e2e smoke against the deploy
          </Bullet>
          <Bullet>
            <code className="font-mono text-sm">$0 / month</code> total deploy cost on free tiers
            (Vercel + Neon + Cloudflare R2 + Langfuse Cloud + Trigger.dev Cloud + Clerk Cloud)
          </Bullet>
          <Bullet>
            Single-developer project. Spec-driven build: design at{" "}
            <a
              href="https://github.com/ahmedEid1/thoth/blob/master/docs/superpowers/specs/thoth-design.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
            >
              docs/superpowers/specs/thoth-design.md
            </a>
            , build order at{" "}
            <a
              href="https://github.com/ahmedEid1/thoth/blob/master/docs/superpowers/plans/thoth-roadmap.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
            >
              docs/superpowers/plans/thoth-roadmap.md
            </a>
          </Bullet>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="eyebrow text-[var(--thoth-stone)]">Stack</h2>
        <p className="text-[var(--thoth-blue-ink)] leading-relaxed">
          Next.js 16 App Router · TypeScript strict · Prisma v7 (driver-adapter `@prisma/adapter-neon`) ·
          Clerk (web sessions + OAuth 2.1 + DCR for MCP) · Trigger.dev v4 ·
          LangGraph 1.3 (TypeScript) · Vercel AI SDK over Mistral / Groq / Gemini / Anthropic /
          OpenAI / Claude Agent SDK · Mistral OCR for PDF parsing · Langfuse OTel for tracing ·
          Tailwind v4 + shadcn/@base-ui · Vitest + Playwright. Deploy on Vercel + Neon (Frankfurt) +
          Cloudflare R2 + Langfuse Cloud + Trigger.dev Cloud + Clerk Cloud, with a docker-compose
          self-host alternative on Oracle Cloud Always Free.
        </p>
      </section>

      <section className="space-y-3 border-t border-[var(--thoth-rule)] pt-8">
        <h2 className="eyebrow text-[var(--thoth-stone)]">Contact</h2>
        <p className="text-[var(--thoth-blue-ink)]">
          <strong>Ahmed Hobeishy</strong> · Essen, Germany ·{" "}
          <a
            href="https://www.linkedin.com/in/ahmedhobeishy/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
          >
            LinkedIn
          </a>{" "}
          ·{" "}
          <a
            href="https://github.com/ahmedEid1"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
          >
            GitHub
          </a>{" "}
          · open to Agentic SWE / Applied AI / full-stack roles in Essen / NRW or remote-EU.
        </p>
      </section>
    </main>
  );
}

function SkillCard({
  title,
  evidence,
  href,
  linkLabel,
}: {
  title: string;
  evidence: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <div className="bg-[var(--thoth-papyrus)] p-6 flex flex-col gap-3">
      <h3 className="font-display text-xl font-medium text-[var(--thoth-blue-ink)] leading-tight">
        {title}
      </h3>
      <p className="text-sm text-[var(--thoth-stone)] leading-relaxed">{evidence}</p>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs font-mono text-[var(--thoth-blue)] hover:underline underline-offset-4 mt-auto"
      >
        → {linkLabel}
      </a>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3 leading-relaxed">
      <span aria-hidden="true" className="text-[var(--thoth-gold)] flex-shrink-0">▸</span>
      <span className="flex-1">{children}</span>
    </li>
  );
}

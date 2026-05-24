import Link from "next/link";
import { Show } from "@clerk/nextjs";
import { DemoCtaButton } from "@/components/home/demo-cta-button";

/* ------------------------------------------------------------------
   Home — the editorial cover page.
   Lays the hero, three differentiators, and the "verified proofs" strip
   under a single column of generous serif typography. Layout is
   asymmetric on desktop (hero text left-aligned, ibis decorative element
   bleeds into the right margin) and centers cleanly on narrow screens.
   ------------------------------------------------------------------ */

export default function Home() {
  return (
    <main className="relative">
      {/* HERO ─────────────────────────────────────────────────────────── */}
      <section className="relative max-w-6xl mx-auto px-6 pt-20 pb-24 lg:pt-28 lg:pb-32">
        {/* Decorative ibis — bleeds off the right margin, subtle */}
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="hidden lg:block absolute top-12 right-0 w-[420px] h-[420px] text-[var(--thoth-blue)] opacity-[0.045] -mr-24 thoth-rise"
          style={{ animationDelay: "120ms" }}
        >
          <path
            fill="currentColor"
            d="M16.8 5.4 C 18.2 5.4 19.3 6.5 19.3 7.9 C 19.3 8.9 18.7 9.8 17.8 10.2 C 18.4 11.0 18.6 12.0 18.3 12.9 L 22 13.6 C 21.0 14.6 18.6 14.7 16.5 14.0 C 15.0 14.0 13.6 13.3 12.7 12.2 L 12.2 14.0 C 12.0 14.7 11.8 15.4 11.4 16.0 C 10.0 18.4 7.6 20.0 5.0 20.4 L 5.0 19.2 C 7.0 18.6 8.8 17.2 9.8 15.4 C 10.5 14.2 10.8 12.8 10.7 11.4 C 10.5 9.6 11.0 7.8 12.2 6.5 C 13.4 5.2 15.0 4.6 16.6 4.8 L 16.8 5.4 Z"
          />
        </svg>

        <div className="relative max-w-3xl">
          <p className="eyebrow thoth-rise" style={{ animationDelay: "0ms" }}>
            Agentic Systematic Literature Reviews
          </p>

          <h1
            className="font-display text-[var(--thoth-blue-ink)] mt-5 leading-[0.95] tracking-tight thoth-rise"
            style={{
              fontSize: "clamp(4.5rem, 11vw, 9.5rem)",
              fontWeight: 500,
              fontVariationSettings: "'opsz' 144, 'SOFT' 50",
              animationDelay: "60ms",
            }}
          >
            Thoth
          </h1>

          <p
            className="mt-8 text-xl md:text-2xl leading-snug text-[var(--thoth-blue-ink)] max-w-2xl thoth-rise"
            style={{ animationDelay: "180ms" }}
          >
            An agent that drafts evidence-grounded literature reviews — and
            verifies <em className="font-display italic text-[var(--thoth-blue)]">every cited claim</em> against
            the source paper before you read the draft.
          </p>

          <p
            className="mt-5 text-sm text-[var(--thoth-stone)] italic max-w-2xl thoth-rise"
            style={{ animationDelay: "260ms" }}
          >
            Named for Thoth, ancient Egypt&rsquo;s ibis-headed god of writing,
            wisdom, and scribes — the divine patron of the work this tool
            automates.
          </p>

          <div
            className="mt-10 flex flex-wrap items-center gap-4 thoth-rise"
            style={{ animationDelay: "340ms" }}
          >
            <Show when="signed-out">
              <DemoCtaButton />
              <Link
                href="/sign-up"
                className="inline-flex items-center gap-2 px-5 py-3 text-sm font-medium text-[var(--thoth-blue-ink)] border border-[var(--thoth-rule)] rounded-md hover:border-[var(--thoth-blue)] hover:text-[var(--thoth-blue)] transition-colors"
              >
                Or sign up
              </Link>
              <Link
                href="/sign-in"
                className="inline-flex items-center px-3 py-3 text-sm font-medium text-[var(--thoth-stone)] hover:text-[var(--thoth-blue)] transition-colors"
              >
                Sign in
              </Link>
            </Show>
            <Show when="signed-in">
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-md bg-[var(--thoth-blue)] text-[var(--thoth-papyrus)] text-sm font-medium tracking-wide hover:bg-[var(--thoth-blue-ink)] transition-colors shadow-[0_1px_0_rgba(0,0,0,0.04),0_2px_8px_-2px_rgba(30,58,138,0.25)]"
              >
                Open dashboard
                <span aria-hidden="true">→</span>
              </Link>
            </Show>
            <a
              href="https://github.com/ahmedEid1/thoth#connect-via-mcp"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-5 py-3 text-sm font-medium text-[var(--thoth-blue-ink)] border border-[var(--thoth-rule)] rounded-md hover:border-[var(--thoth-blue)] hover:text-[var(--thoth-blue)] transition-colors"
            >
              Connect via MCP
              <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </section>

      {/* DIFFERENTIATORS ─────────────────────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-6 py-20 border-t border-[var(--thoth-rule)]">
        <div className="flex items-baseline justify-between mb-12 gap-8 flex-wrap">
          <h2 className="font-display text-3xl md:text-4xl font-medium text-[var(--thoth-blue-ink)] tracking-tight">
            What makes Thoth different
          </h2>
          <p className="text-sm text-[var(--thoth-stone)] max-w-md">
            Four design choices that separate Thoth from generic
            &ldquo;AI&nbsp;research&rdquo; tools.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-px bg-[var(--thoth-rule)] border border-[var(--thoth-rule)] rounded-lg overflow-hidden">
          <Differentiator
            num="01"
            title="cite_check post-pass"
            body="Every cited claim is verified against the source paper before the draft reaches you. Hallucinated citations are flagged, not hidden."
          />
          <Differentiator
            num="02"
            title="Authenticated MCP server"
            body="OAuth 2.1 + PKCE + Dynamic Client Registration via Clerk, with SHA-256 audit logs. Listed in the official MCP Registry."
          />
          <Differentiator
            num="03"
            title="Public eval dashboard"
            body="Every commit can run the agent against a versioned golden set; results render at /evals. Regressions are visible, not buried."
          />
          <Differentiator
            num="04"
            title="6 LLM providers, $0 default"
            body="Swap providers with one env var. Mistral free tier is default. Local eval runs ride a Claude Max subscription via the agent SDK."
          />
        </div>
      </section>

      {/* VERIFIED PROOFS STRIP ───────────────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-6 py-20 border-t border-[var(--thoth-rule)]">
        <p className="eyebrow mb-6">Verified engineering proofs</p>
        <div className="flex flex-wrap gap-2.5 mb-8">
          <Proof href="/evals" label="Public eval dashboard" />
          <Proof
            href="https://registry.modelcontextprotocol.io/v0.1/servers?search=thoth"
            external
            label={
              <>
                MCP Registry —{" "}
                <code className="font-mono text-[0.78em] text-[var(--thoth-blue)]">
                  io.github.ahmedEid1/thoth
                </code>
              </>
            }
          />
          <Proof
            href="https://github.com/ahmedEid1/thoth"
            external
            label="199 tests · tsc · lint · all green"
          />
          <Proof label="SHA-256 audit log on every MCP call · no raw input stored" />
          <Proof label="$0 / month deploy on free tiers" />
        </div>
        <p className="text-xs text-[var(--thoth-stone)] max-w-2xl">
          Spec-driven build:{" "}
          <a
            href="https://github.com/ahmedEid1/thoth/tree/master/docs/superpowers/specs"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
          >
            specs
          </a>
          {" → "}
          <a
            href="https://github.com/ahmedEid1/thoth/tree/master/docs/superpowers/plans"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
          >
            plans
          </a>
          {" → TDD subagents → reviewed → shipped. v0.7.0-m5 live. M6 (30-question eval set + public launch) next."}
        </p>
      </section>
    </main>
  );
}

function Differentiator({
  num,
  title,
  body,
}: {
  num: string;
  title: string;
  body: string;
}) {
  return (
    <div className="bg-[oklch(1_0_0)] p-7 flex flex-col gap-3 group hover:bg-[var(--thoth-blue-mist)]/30 transition-colors">
      <div className="flex items-baseline justify-between">
        <span className="font-display text-2xl text-[var(--thoth-gold)] tabular-nums">
          {num}
        </span>
        <span
          aria-hidden="true"
          className="text-xs text-[var(--thoth-stone)] opacity-0 group-hover:opacity-100 transition-opacity"
        >
          ━━
        </span>
      </div>
      <h3 className="font-display text-[1.35rem] font-medium text-[var(--thoth-blue-ink)] leading-tight">
        {title}
      </h3>
      <p className="text-sm leading-relaxed text-[var(--thoth-stone)]">{body}</p>
    </div>
  );
}

function Proof({
  href,
  external,
  label,
}: {
  href?: string;
  external?: boolean;
  label: React.ReactNode;
}) {
  const inner = (
    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-[var(--thoth-blue-ink)] bg-[oklch(1_0_0)] border border-[var(--thoth-rule)] rounded-full hover:border-[var(--thoth-blue)] transition-colors">
      {label}
      {external && <span aria-hidden="true">↗</span>}
    </span>
  );
  if (!href) return inner;
  if (external)
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {inner}
      </a>
    );
  return <Link href={href}>{inner}</Link>;
}

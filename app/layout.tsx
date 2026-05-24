import { ClerkProvider, Show, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import "./globals.css";
import type { Metadata } from "next";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import { cn } from "@/lib/utils";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
  axes: ["opsz", "SOFT"],
});

export const metadata: Metadata = {
  title: "Thoth — Agentic systematic literature reviews",
  description:
    "Multi-step LangGraph agent that drafts evidence-grounded literature reviews and verifies every cited claim against the source paper before you read the draft.",
};

function IbisMark({ className = "" }: { className?: string }) {
  // Stylized sacred ibis — round head, long down-curving beak (the iconic
  // species marker), oval body, thin legs. Designed to read as an ibis
  // even at 16-24px favicon scale. Same artwork as app/icon.svg.
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      {/* Body */}
      <ellipse cx="11" cy="17" rx="6" ry="3.2" />
      {/* Tail point on the left */}
      <path d="M 5 16 L 2 17 L 5 18 Z" />
      {/* Neck connecting body to head */}
      <path d="M 14.5 14.5 C 16.5 12, 18 10, 19 8.5 L 20 9 C 19 11, 17.5 13.5, 15.5 16 Z" />
      {/* Head */}
      <circle cx="20.5" cy="8.5" r="2.4" />
      {/* Iconic long downward-curving beak */}
      <path
        d="M 22 10.5 C 24 13, 26 17, 28 21.5"
        stroke="currentColor"
        strokeWidth="1.7"
        fill="none"
        strokeLinecap="round"
      />
      {/* Eye highlight */}
      <circle cx="20.8" cy="7.8" r="0.55" fill="var(--thoth-papyrus, #FAF7F0)" />
      {/* Thin wading legs */}
      <line x1="9" y1="20" x2="8" y2="27" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="12" y1="20" x2="13" y2="27" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={cn(
          geistSans.variable,
          geistMono.variable,
          fraunces.variable
        )}
      >
        <body className="min-h-screen bg-background text-foreground antialiased">
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-[var(--thoth-blue-ink)] focus:text-[var(--thoth-papyrus)] focus:px-3 focus:py-2 focus:rounded focus:shadow-lg"
          >
            Skip to content
          </a>
          <header className="border-b border-[var(--thoth-rule)]">
            <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
              <Link
                href="/"
                className="flex items-center gap-2.5 group"
                aria-label="Thoth — home"
              >
                <IbisMark className="w-6 h-6 text-[var(--thoth-blue)] transition-transform group-hover:-rotate-3" />
                <span className="font-display text-[1.35rem] font-medium tracking-tight text-[var(--thoth-blue-ink)]">
                  Thoth
                </span>
              </Link>
              <nav className="flex items-center gap-6 text-sm">
                <Link
                  href="/evals"
                  className="text-[var(--thoth-stone)] hover:text-[var(--thoth-blue-ink)] transition-colors"
                >
                  Evals
                </Link>
                <a
                  href="https://github.com/ahmedEid1/thoth"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--thoth-stone)] hover:text-[var(--thoth-blue-ink)] transition-colors"
                >
                  GitHub
                </a>
                <Show when="signed-in">
                  <Link
                    href="/dashboard"
                    className="text-[var(--thoth-stone)] hover:text-[var(--thoth-blue-ink)] transition-colors"
                  >
                    Dashboard
                  </Link>
                  <UserButton />
                </Show>
                <Show when="signed-out">
                  <Link
                    href="/sign-in"
                    className="inline-flex items-center px-3.5 py-1.5 rounded-md text-[var(--thoth-blue-ink)] border border-[var(--thoth-rule)] hover:border-[var(--thoth-blue)] hover:text-[var(--thoth-blue)] transition-colors"
                  >
                    Sign in
                  </Link>
                </Show>
              </nav>
            </div>
          </header>

          <div className="min-h-[calc(100vh-4rem-3.5rem)]">{children}</div>

          <footer className="border-t border-[var(--thoth-rule)] mt-16">
            <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between text-xs text-[var(--thoth-stone)]">
              <div className="flex items-center gap-2">
                <IbisMark className="w-3.5 h-3.5 text-[var(--thoth-stone)]" />
                <span>
                  Thoth — named for ancient Egypt&rsquo;s ibis-headed god of writing and scribes.
                </span>
              </div>
              <div className="flex items-center gap-4">
                <a
                  href="https://registry.modelcontextprotocol.io/v0.1/servers?search=thoth"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-[var(--thoth-blue-ink)] transition-colors"
                >
                  MCP Registry
                </a>
                <a
                  href="https://github.com/ahmedEid1/thoth"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-[var(--thoth-blue-ink)] transition-colors"
                >
                  Source
                </a>
              </div>
            </div>
          </footer>
        </body>
      </html>
    </ClerkProvider>
  );
}

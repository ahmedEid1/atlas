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
  // Inline ibis silhouette — same path family as app/icon.svg, scaled for nav.
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M16.8 5.4 C 18.2 5.4 19.3 6.5 19.3 7.9 C 19.3 8.9 18.7 9.8 17.8 10.2 C 18.4 11.0 18.6 12.0 18.3 12.9 L 22 13.6 C 21.0 14.6 18.6 14.7 16.5 14.0 C 15.0 14.0 13.6 13.3 12.7 12.2 L 12.2 14.0 C 12.0 14.7 11.8 15.4 11.4 16.0 C 10.0 18.4 7.6 20.0 5.0 20.4 L 5.0 19.2 C 7.0 18.6 8.8 17.2 9.8 15.4 C 10.5 14.2 10.8 12.8 10.7 11.4 C 10.5 9.6 11.0 7.8 12.2 6.5 C 13.4 5.2 15.0 4.6 16.6 4.8 L 16.8 5.4 Z" />
      <circle cx="17.2" cy="7.6" r="0.7" fill="var(--thoth-papyrus, #FAF7F0)" />
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

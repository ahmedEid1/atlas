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
  // Ibis icon by Delapouite (https://delapouite.com), CC BY 3.0,
  // via game-icons.net (https://game-icons.net/1x1/delapouite/ibis.html).
  // Same artwork as app/icon.svg; uses currentColor so it tints with
  // text-* utility classes.
  return (
    <svg
      viewBox="0 0 512 512"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M338.5 30.72c-20.8-.19-31.3 17.85-29.7 43.43 1.3 20.21 18.9 45.45 26.4 70.35 3.7 12.3-8.1 20-18.2 18.9-98.7-10.7-140.9 35-194.9 70.7-81.68 23.9-110.5 141.6-14.3 72.3 36.6 10.7 64.6 3.1 96-.6 5.4 11.5 12.7 29.7 24.4 29.4 7.8.4 17.1-16.1 20.7-27.8 42.8-15.2 75.2-62.1 105.7-101.8 12.5-16.3 22.3-34.3 19.4-59.4-1.4-12-13.7-36.2-22.3-56.82-5.4-13 10.8-9.45 19.5-8.17l6.6-24.51c-5.3-16.62-18-23.64-35-25.69-1.5-.18-2.9-.27-4.3-.29zm52 33.88-6 22.05c31.1 9.07 72.3 72.45 80.2 82.65-2.3-24.7-24.7-68.2-74.2-104.7zM194.7 325.2c-2.2.7-4.3 1.2-6.4 1.6-6.2 12.4-12.6 27-15 40.3-2.7 15.3-1.1 36.9.8 55.7 1.1 10.7 2.4 19.9 3.3 26.3-10.1 3.7-18.6 8.2-27.8 14l9.8 15.2c18.9-12.9 35.3-11.2 45.9 3 29.7-22.2 52.1-10.3 81.7 0l6-17c-18.4-5.2-36.5-13-55.6-13.8-1.1-4.8-2.3-10.3-3.6-16.5-3.4-16.6-6.8-36.4-6.9-46.5-.1-10.5 2-25 4.3-37-1.6.2-3.2.3-4.8.2-4.8-.3-9.1-1.8-12.9-4.1-2.4 12.5-4.7 28.2-4.6 41.1.2 13.5 3.8 33 7.3 49.9 1.2 5.8 2.4 11 3.4 15.7-3.5 1.2-6.7 2.5-9.7 4 0-.1-.1-.1-.2-.2-3.8-2.9-8.4-6.3-14.1-8.2-.9-5.8-2.4-15.9-3.6-27.9-1.8-18.2-2.9-40.1-.9-50.7 1.6-9 6.6-21.4 11.9-32.5-3.3-3.7-6.1-8.1-8.3-12.6z" />
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

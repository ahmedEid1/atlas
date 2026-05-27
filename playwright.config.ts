import { defineConfig } from "@playwright/test";
import dotenv from "dotenv";

// Load .env for CLERK_SECRET_KEY / NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY used by clerkSetup
dotenv.config({ path: ".env" });
// Load .env.test for E2E_EMAIL / E2E_PASSWORD (overrides nothing from .env)
dotenv.config({ path: ".env.test" });

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3001";
// "Live" = anything that isn't the local dev server. When live, we don't spin
// up the Next.js dev server and we only run the mcp-smoke test (the other e2e
// tests need a real Clerk session against a local Thoth instance and aren't
// safe to run against production anyway).
const IS_LIVE = !BASE_URL.includes("localhost") && !BASE_URL.includes("127.0.0.1");

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  // Live e2e against an external network occasionally hits transient
  // failures (ERR_NETWORK_CHANGED, Clerk cold starts, Vercel edge
  // failover). 1 retry lets the suite tolerate them without polluting
  // CI signal. Local runs against the dev server keep retries=0 since
  // a local flake is a real bug to investigate.
  retries: IS_LIVE ? 1 : 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "retain-on-failure",
  },
  projects: IS_LIVE
    ? [
        {
          name: "chromium",
          use: { browserName: "chromium" },
          // Live mode: the API-level MCP smoke + the real-browser public-
          // surface smoke. Both exercise the deploy without needing a
          // Clerk-session setup (mcp-smoke runs the unauthenticated half
          // of the OAuth flow; live-browser-smoke hits only public pages).
          testMatch: /(mcp-smoke|live-browser-smoke|live-auth-walkthrough)\.spec\.ts/,
        },
      ]
    : [
        {
          name: "global setup",
          testMatch: /global\.setup\.ts/,
        },
        {
          name: "chromium",
          use: { browserName: "chromium" },
          dependencies: ["global setup"],
        },
      ],
  // Only spin up a local dev server when targeting localhost.
  webServer: IS_LIVE
    ? undefined
    : {
        command: "pnpm dev --port 3001",
        url: "http://localhost:3001",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});

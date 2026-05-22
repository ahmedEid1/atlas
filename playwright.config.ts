import { defineConfig } from "@playwright/test";
import dotenv from "dotenv";

// Load .env for CLERK_SECRET_KEY / NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY used by clerkSetup
dotenv.config({ path: ".env" });
// Load .env.test for E2E_EMAIL / E2E_PASSWORD (overrides nothing from .env)
dotenv.config({ path: ".env.test" });

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3001",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
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
  webServer: {
    command: "pnpm dev --port 3001",
    url: "http://localhost:3001",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

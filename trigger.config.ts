import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { config as dotenvConfig } from "dotenv";

// SyncEnvVars callback — runs at deploy time, pushes resolved env vars to
// Trigger.dev's project env so worker tasks have what they need at runtime.
// Reads from local .env (which IS the source of truth for Atlas dev/local).
// Filters out CLI-only vars (TRIGGER_*) that shouldn't be in the worker env.
//
// IMPORTANT: this means local .env values are pushed to the prod Trigger.dev
// env on every deploy. Don't put untrusted values in .env if you don't want
// them in the Trigger.dev project.
async function loadSyncEnv() {
  const result = dotenvConfig({ path: ".env", processEnv: {} });
  if (result.error) return [];
  const skip = new Set(["TRIGGER_PROJECT_REF", "TRIGGER_SECRET_KEY"]);
  return Object.entries(result.parsed ?? {})
    .filter(([k]) => !skip.has(k))
    .map(([name, value]) => ({ name, value }));
}

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  dirs: ["./trigger"],
  runtime: "node",
  logLevel: "info",
  maxDuration: 600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30000,
      randomize: true,
    },
  },
  build: {
    extensions: [
      prismaExtension({
        mode: "modern",
      }),
      syncEnvVars(loadSyncEnv),
    ],
  },
});

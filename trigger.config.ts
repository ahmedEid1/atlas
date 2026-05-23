import { defineConfig } from "@trigger.dev/sdk";
import { pythonExtension } from "@trigger.dev/python/extension";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

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
      pythonExtension({
        scripts: ["./python/**/*.py"],
        // Path workaround for triggerdotdev/trigger.dev#1843 — nested
        // requirements.txt paths fail during Docker build; root works.
        requirementsFile: "./requirements.txt",
        devPythonBinaryPath: "./python/.venv/Scripts/python.exe",
      }),
      prismaExtension({
        mode: "modern",
      }),
    ],
  },
});

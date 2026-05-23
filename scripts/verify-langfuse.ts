import "dotenv/config";
import { z } from "zod";
import { getLangfuse } from "../lib/langfuse";
import { runLLM } from "../lib/llm";

async function main() {
  console.log("→ Sending an explicit Langfuse trace via direct SDK...");
  const lf = getLangfuse();
  const t0 = Date.now();
  const trace = lf.trace({
    name: "m3.5b-langfuse-smoke",
    metadata: { source: "scripts/verify-langfuse.ts" },
    input: { kind: "manual" },
    tags: ["m3.5b", "smoke"],
  });
  trace.event({ name: "ping", input: { hello: "langfuse cloud" } });
  trace.update({ output: { ok: true } });
  await lf.flushAsync();
  console.log(`  ✓ direct trace flushed in ${Date.now() - t0}ms`);
  console.log(`  view: https://cloud.langfuse.com/project/-/traces (look for "m3.5b-langfuse-smoke")`);

  console.log("\n→ Running a real Gemini call through runLLM (telemetry stays attached via experimental_telemetry)...");
  const t1 = Date.now();
  const result = await runLLM({
    name: "m3.5b-runLLM-smoke",
    tier: "fast",
    maxTokens: 100,
    system: "You are a helpful assistant.",
    messages: [{ role: "user", content: "What's the capital of Germany? Reply in JSON." }],
    schema: z.object({ capital: z.string() }),
    metadata: { runId: "m3.5b-smoke-run" },
  });
  console.log(`  ✓ Gemini answered in ${Date.now() - t1}ms: ${JSON.stringify(result.output)}`);
  console.log(`  note: runLLM uses experimental_telemetry which the OTel exporter forwards`);
  console.log(`        — this only fires inside Next.js, so the runLLM call here WON'T show in Langfuse.`);
  console.log(`        Confirm Step 4 by checking the "m3.5b-langfuse-smoke" trace from the direct SDK.`);

  console.log("\n✓ Langfuse Cloud smoke complete.");
}

main().catch((err) => {
  console.error("✗ FAIL:", err);
  process.exit(1);
});

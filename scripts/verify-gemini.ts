import "dotenv/config";
import { z } from "zod";
import { runLLM } from "../lib/llm";

const Schema = z.object({
  greeting: z.string().describe("A short friendly greeting"),
  answer: z.number().describe("The numeric answer to the math question"),
  confidence: z.enum(["low", "medium", "high"]),
});

async function main() {
  console.log("→ Calling Gemini (gemini-2.5-flash) via runLLM...");
  const start = Date.now();

  const result = await runLLM({
    name: "smoke-gemini",
    tier: "fast",
    maxTokens: 200,
    system: "You are a helpful assistant. Reply concisely with structured JSON.",
    messages: [
      {
        role: "user",
        content: "Say hello in 5 words, then answer: what is 7 times 8?",
      },
    ],
    schema: Schema,
    metadata: { runId: "smoke-test", source: "scripts/verify-gemini.ts" },
  });

  const elapsed = Date.now() - start;
  console.log(`✓ Gemini call succeeded in ${elapsed}ms`);
  console.log("  Output:", JSON.stringify(result.output, null, 2));
  console.log("  Usage:", result.usage);

  if (result.output.answer !== 56) {
    console.error(`✗ Expected answer=56, got ${result.output.answer}`);
    process.exit(1);
  }
  console.log("✓ Schema-validated, math correct (7 × 8 = 56)");
}

main().catch((err) => {
  console.error("✗ FAIL:", err);
  process.exit(1);
});

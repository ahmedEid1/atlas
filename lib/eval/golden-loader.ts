import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { GoldenQuestionSchema, type GoldenQuestion } from "@/lib/eval/golden-schema";

const GOLDEN_DIR = "evals/golden";

/**
 * Read all .yaml files under evals/golden/, parse them, validate with
 * GoldenQuestionSchema, and return the array. Throws with a file-attributing
 * message on the first validation failure.
 */
export async function loadGolden(): Promise<GoldenQuestion[]> {
  const files = await readdir(GOLDEN_DIR);
  const yamlFiles = files.filter((f) => f.endsWith(".yaml")).sort();
  const out: GoldenQuestion[] = [];
  for (const f of yamlFiles) {
    const raw = await readFile(join(GOLDEN_DIR, f), "utf8");
    const parsed = yamlLoad(raw);
    const result = GoldenQuestionSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Golden question ${f} failed validation: ${issues}`);
    }
    out.push(result.data);
  }
  return out;
}

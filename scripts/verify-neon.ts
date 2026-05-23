import "dotenv/config";
import { db } from "../lib/db";

async function main() {
  console.log("→ Connecting to Neon via PrismaNeon adapter (pooled URL)...");
  const start = Date.now();

  const tables = [
    { name: "User", count: () => db.user.count() },
    { name: "Project", count: () => db.project.count() },
    { name: "CorpusItem", count: () => db.corpusItem.count() },
    { name: "Run", count: () => db.run.count() },
    { name: "RunStep", count: () => db.runStep.count() },
    { name: "HumanCheckpoint", count: () => db.humanCheckpoint.count() },
    { name: "IncludedPaper", count: () => db.includedPaper.count() },
    { name: "ExtractedClaim", count: () => db.extractedClaim.count() },
  ];

  console.log(`✓ Connected. Table row counts:`);
  for (const t of tables) {
    const n = await t.count();
    console.log(`  ${t.name.padEnd(18)} ${n}`);
  }

  const elapsed = Date.now() - start;
  console.log(`✓ All 8 tables queryable in ${elapsed}ms`);

  await db.$disconnect();
}

main().catch((err) => {
  console.error("✗ FAIL:", err);
  process.exit(1);
});

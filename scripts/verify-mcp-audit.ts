import "dotenv/config";
import { db } from "../lib/db";

async function main() {
  console.log("→ Querying McpCall audit log...\n");

  const total = await db.mcpCall.count();
  console.log(`Total McpCall rows: ${total}\n`);

  if (total === 0) {
    console.log("(no rows yet — run a tool via Inspector or Claude Desktop first)");
    return;
  }

  const recent = await db.mcpCall.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      userId: true,
      toolName: true,
      reviewId: true,
      status: true,
      errorCode: true,
      latencyMs: true,
      createdAt: true,
    },
  });

  console.log(`Most recent ${recent.length} calls:\n`);
  for (const r of recent) {
    const time = r.createdAt.toISOString().slice(11, 19);
    const status = r.status === "OK" ? "OK   " : `ERROR(${r.errorCode ?? "?"})`;
    const review = r.reviewId ? ` review=${r.reviewId.slice(0, 12)}…` : "";
    console.log(
      `  ${time}  ${status.padEnd(18)} ${r.toolName.padEnd(20)} ${r.latencyMs.toString().padStart(5)}ms  user=${r.userId.slice(0, 12)}…${review}`,
    );
  }

  const byTool = await db.mcpCall.groupBy({
    by: ["toolName", "status"],
    _count: { _all: true },
  });
  console.log("\nBy tool + status:");
  for (const g of byTool) {
    console.log(`  ${g.toolName.padEnd(20)} ${g.status.padEnd(6)} ${g._count._all}`);
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error("✗ Failed:", e);
  process.exit(1);
});

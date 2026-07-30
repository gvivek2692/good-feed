import "@/lib/env";

import { prisma } from "@/lib/db/client";
import { liveDeps } from "@/lib/pipeline/deps";
import { runPipeline } from "@/lib/pipeline/runner";

/**
 * Runs the full pipeline against live sources and the live Gemini API, then
 * prints the run log.
 *
 * This is the Checkpoint C artifact. It is the first thing that exercises
 * fetch → publish end to end against real infrastructure, and the first
 * measurement of Gemini rate limits at ingest volume (spec open question 1).
 *
 * Not part of `npm test` — it writes to the database and spends quota.
 * Run with: npx tsx scripts/check-pipeline.mts [days] [limit] [maxItems]
 */
async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 2);
  const limit = Number(process.argv[3] ?? 30);
  const since = new Date(Date.now() - days * 86_400_000);

  console.log(`fetching since ${since.toISOString()} (limit ${limit} per source)\n`);

  const started = Date.now();
  const maxItems = process.argv[4] ? Number(process.argv[4]) : undefined;
  const result = await runPipeline(prisma, {
    ...liveDeps({ since, limit, maxItems }),
    onProgress: ({ index, total, title, outcome }) =>
      console.log(`  [${index}/${total}] ${outcome.padEnd(26)} ${title.slice(0, 52)}`),
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (!result.ok) {
    console.log(`RUN FAILED (${elapsed}s): ${result.error.kind} — ${result.error.message}`);
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  const { runId, ...counts } = result.value;
  console.log(`run ${runId} completed in ${elapsed}s`);
  console.log(
    `  fetched=${counts.fetched} clustered=${counts.clustered} ` +
      `summarized=${counts.summarized} published=${counts.published}`,
  );
  console.log(`  dropped=${counts.dropped} assertionsStripped=${counts.assertionsStripped}`);

  const drops = await prisma.droppedItem.groupBy({
    by: ["stage", "reason"],
    where: { runId },
    _count: true,
  });

  if (drops.length > 0) {
    console.log("\ndrops by stage and reason:");
    for (const drop of drops.sort((a, b) => b._count - a._count)) {
      console.log(`  ${drop.stage.padEnd(10)} ${drop.reason.padEnd(28)} ${drop._count}`);
    }
  }

  const top = await prisma.item.findMany({
    where: { published: true },
    orderBy: { importanceScore: "desc" },
    take: 10,
    include: { claims: true, topics: { include: { topic: true } } },
  });

  console.log(`\n${"=".repeat(74)}\nTOP 10 IN THE FEED\n${"=".repeat(74)}`);
  for (const [index, item] of top.entries()) {
    const topics = item.topics.map((t) => t.topic.slug).join(", ") || "unclassified";
    console.log(
      `\n${index + 1}. ${item.importanceScore?.toFixed(3)} [${topics}] ${item.title.slice(0, 60)}`,
    );
    console.log(`   ${item.summary?.slice(0, 150)}`);
    if (item.whyItMatters) console.log(`   WHY: ${item.whyItMatters.slice(0, 150)}`);
    if (item.claims.length > 0) console.log(`   claims: ${item.claims.length}`);
  }

  await prisma.$disconnect();
}

void main();

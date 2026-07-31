import "@/lib/env";

import { prisma } from "@/lib/db/client";
import { generateDeepDive } from "@/lib/pipeline/deep-dive";
import { resolveQuotableSource } from "@/lib/pipeline/dive-source";

/**
 * Generates deep dives for items published before pre-generation existed.
 *
 * The pipeline now writes a dive as it publishes, so this only ever covers the
 * backlog and any item whose dive failed at publish time. Paced like the
 * runner, because the free-tier limit is per minute.
 *
 * Highest-scoring items first: those are the ones most likely to be opened, so
 * an interrupted run still leaves the feed better off.
 *
 * Run with: npx tsx scripts/backfill-deep-dives.mts [limit]
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? 30);

  const items = await prisma.item.findMany({
    where: { published: true, deepDive: null },
    orderBy: { importanceScore: "desc" },
    take: limit,
    include: { source: true },
  });

  console.log(`${items.length} published item(s) have no deep dive\n`);

  let done = 0;
  let failed = 0;

  for (const [index, item] of items.entries()) {
    if (index > 0) await sleep(6_000);

    const raw = item.source.rawPayload as Record<string, unknown>;
    const baseText =
      (raw.summary as string) ??
      (raw.abstract as string) ??
      (raw.story_text as string) ??
      (raw.text as string) ??
      "";

    const quotableSource = await resolveQuotableSource(baseText, item.canonicalUrl);

    const started = Date.now();
    const generated = await generateDeepDive({
      title: item.title,
      headline: item.headline,
      summary: item.summary,
      whyItMatters: item.whyItMatters,
      quotableSource,
      authors: item.authors,
      sourceKinds: [item.source.kind],
    });

    if (!generated.ok) {
      failed += 1;
      console.log(`  FAILED  ${generated.error.kind}  ${item.title.slice(0, 50)}`);
      continue;
    }

    // Upsert rather than create: a concurrent reader may have generated this
    // item's dive on demand between the query above and this write.
    await prisma.deepDive.upsert({
      where: { itemId: item.id },
      create: { itemId: item.id, content: generated.value.content },
      update: { content: generated.value.content },
    });

    done += 1;
    const words = generated.value.content.trim().split(/\s+/).length;
    console.log(
      `  ${words}w in ${Math.round((Date.now() - started) / 100) / 10}s  ${item.title.slice(0, 50)}`,
    );
  }

  console.log(`\ndives written: ${done} · failed: ${failed}`);
  await prisma.$disconnect();
}

void main();

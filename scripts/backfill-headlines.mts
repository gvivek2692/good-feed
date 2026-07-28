import "@/lib/env";

import { prisma } from "@/lib/db/client";
import { isHeadlineGrounded } from "@/lib/pipeline/claims";
import { summarizeCluster } from "@/lib/pipeline/summarize";
import { type Cluster } from "@/lib/pipeline/clustering";
import { type NormalizedItem } from "@/lib/sources/types";

/**
 * Generates headlines for items summarized before headlines existed.
 *
 * Re-running the whole pipeline would work but would re-summarize and re-rank
 * everything; this touches only the missing field. Paced like the runner,
 * because the free-tier limit is per minute.
 *
 * Run with: npx tsx scripts/backfill-headlines.mts [limit]
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? 30);

  const items = await prisma.item.findMany({
    where: { published: true, headline: null },
    orderBy: { importanceScore: "desc" },
    take: limit,
    include: { source: true, claims: true },
  });

  console.log(`${items.length} item(s) need a headline\n`);

  let done = 0;
  let fellBack = 0;
  let failed = 0;

  for (const [index, item] of items.entries()) {
    if (index > 0) await sleep(6_000);

    // Reconstruct the minimum a summarize call needs. The raw payload is
    // retained at ingest precisely so this kind of reprocessing is possible.
    const raw = item.source.rawPayload as Record<string, unknown>;
    const text =
      (raw.summary as string) ?? (raw.abstract as string) ?? (raw.story_text as string) ?? null;

    const normalized: NormalizedItem = {
      externalId: item.source.externalId,
      kind: item.source.kind,
      title: item.title,
      authors: item.authors,
      publishedAt: item.publishedAt,
      canonicalUrl: item.canonicalUrl,
      sourceUrl: item.source.url,
      text,
      arxivId: null,
      signals: {},
      raw,
    };

    const cluster: Cluster = {
      id: item.clusterId ?? item.id,
      items: [normalized],
      sourceCount: 1,
      primary: normalized,
    };

    const result = await summarizeCluster(cluster, { maxRetries: 2 });

    if (!result.ok) {
      failed += 1;
      console.log(`  FAILED  ${result.error.kind}  ${item.title.slice(0, 50)}`);
      continue;
    }

    const grounded = isHeadlineGrounded(
      result.value.headline,
      result.value.claims,
      result.value.quotableSource,
    );

    if (!grounded) {
      fellBack += 1;
      console.log(`  UNGROUNDED (keeping title)  "${result.value.headline}"`);
      continue;
    }

    await prisma.item.update({
      where: { id: item.id },
      data: { headline: result.value.headline },
    });

    done += 1;
    console.log(`  ${result.value.headline}`);
    console.log(`     was: ${item.title.slice(0, 66)}`);
  }

  console.log(`\nheadlines written: ${done} · ungrounded: ${fellBack} · failed: ${failed}`);
  await prisma.$disconnect();
}

void main();

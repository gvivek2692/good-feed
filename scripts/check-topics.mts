import "dotenv/config";
import { readFileSync } from "node:fs";

import { clusterItems, dedupeWithinSource } from "@/lib/pipeline/clustering";
import { classifyCluster, CONFIDENCE_THRESHOLD } from "@/lib/pipeline/topics";
import { parseAtomFeed } from "@/lib/sources/arxiv";
import { parseDailyPapers } from "@/lib/sources/huggingface";
import { type TopicSlug } from "@/lib/topics/taxonomy";

/**
 * Classifies real items and reports the confidence distribution and topic
 * spread.
 *
 * The threshold constant is only defensible against measured output: if every
 * assignment lands at 0.9+, the threshold is filtering nothing and needs
 * raising; if topics pile onto two slugs, the taxonomy or the prompt is the
 * problem. Not part of `npm test`.
 * Run with: npx tsx scripts/check-topics.mts
 */
async function main(): Promise<void> {
  const arxiv = parseAtomFeed(readFileSync("tests/fixtures/arxiv-recent.xml", "utf-8"));
  const hf = parseDailyPapers(
    JSON.parse(readFileSync("tests/fixtures/hf-daily-papers.json", "utf-8")),
  );
  if (!arxiv.ok || !hf.ok) throw new Error("fixtures failed to parse");

  const clusters = clusterItems(dedupeWithinSource([...arxiv.value, ...hf.value]))
    .sort((a, b) => Number(b.primary.signals.upvotes ?? 0) - Number(a.primary.signals.upvotes ?? 0))
    .slice(0, 20);

  const confidences: number[] = [];
  const counts = new Map<TopicSlug, number>();
  let unclassified = 0;
  let invented = 0;
  let failed = 0;

  for (const cluster of clusters) {
    const result = await classifyCluster(cluster, { maxRetries: 1 });
    if (!result.ok) {
      failed += 1;
      console.log(`FAILED  ${cluster.primary.title.slice(0, 52)} — ${result.error.kind}`);
      continue;
    }

    const { topics, rejected } = result.value;
    invented += rejected.length;
    if (result.value.unclassified) unclassified += 1;

    for (const topic of topics) {
      confidences.push(topic.confidence);
      counts.set(topic.slug, (counts.get(topic.slug) ?? 0) + 1);
    }

    const rendered = topics.map((t) => `${t.slug}(${t.confidence.toFixed(2)})`).join(", ");
    console.log(`${(rendered || "UNCLASSIFIED").padEnd(58)} ${cluster.primary.title.slice(0, 46)}`);
    if (rejected.length > 0) console.log(`  INVENTED SLUGS: ${rejected.join(", ")}`);
  }

  const sorted = [...confidences].sort((a, b) => a - b);
  const pct = (p: number): number => sorted[Math.floor((sorted.length - 1) * p)] ?? 0;

  console.log(`\n${"=".repeat(70)}`);
  console.log(`classified: ${clusters.length - unclassified - failed}/${clusters.length}`);
  console.log(`unclassified: ${unclassified} · failed: ${failed} · invented slugs: ${invented}`);
  console.log(`assignments: ${confidences.length}`);
  if (sorted.length > 0) {
    console.log(
      `confidence  min ${sorted[0].toFixed(2)} · p25 ${pct(0.25).toFixed(2)} · ` +
        `median ${pct(0.5).toFixed(2)} · max ${sorted[sorted.length - 1].toFixed(2)}`,
    );
    const belowThreshold = sorted.filter((c) => c < CONFIDENCE_THRESHOLD).length;
    console.log(
      `threshold ${CONFIDENCE_THRESHOLD}: ${belowThreshold}/${sorted.length} kept assignments sit below it ` +
        `(should be 0 — anything below was already dropped)`,
    );
  }

  console.log(`\ntopic spread (${counts.size}/15 slugs used):`);
  for (const [slug, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${slug.padEnd(24)} ${"█".repeat(count)} ${count}`);
  }
}

void main();

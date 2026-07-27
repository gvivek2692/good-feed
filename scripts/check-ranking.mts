import { readFileSync } from "node:fs";

import { clusterItems, dedupeWithinSource } from "@/lib/pipeline/clustering";
import { buildDistributions, rankClusters, type ScoredCluster } from "@/lib/ranking/score";
import { parseAtomFeed } from "@/lib/sources/arxiv";
import { parseSearchResponse } from "@/lib/sources/hackernews";
import { parseDailyPapers } from "@/lib/sources/huggingface";

/**
 * Ranks the full fixture corpus and prints the top 25 with signal breakdowns.
 *
 * This is the Checkpoint B artifact: a human reads the ordering and judges
 * whether it is defensible, paying particular attention to whether papers and
 * HN stories interleave sensibly or whether one cluster dominates for
 * structural rather than merit reasons.
 *
 * No API calls — ranking is signal-only by design.
 * Run with: npx tsx scripts/check-ranking.mts
 */
function line(entry: ScoredCluster, index: number): string {
  const { snapshot, cluster, score } = entry;
  const tag = snapshot.cluster === "research" ? "PAPER" : "HN   ";
  const signals = Object.entries(snapshot.raw)
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
  const pcts = Object.entries(snapshot.percentiles)
    .map(([name, value]) => `${name} p${Math.round(value * 100)}`)
    .join(" ");

  return [
    `${String(index + 1).padStart(2)}. [${tag}] ${score.toFixed(3)} ` +
      `${entry.included ? "" : "(EXCLUDED) "}${cluster.primary.title.slice(0, 62)}`,
    `      sources=${snapshot.sourceCount} recency=${snapshot.recencyMultiplier.toFixed(2)} ` +
      `pos-in-cluster=${snapshot.withinClusterPosition}`,
    `      raw: ${signals}`,
    `      pct: ${pcts}`,
  ].join("\n");
}

function main(): void {
  const arxiv = parseAtomFeed(readFileSync("tests/fixtures/arxiv-recent.xml", "utf-8"));
  const hf = parseDailyPapers(
    JSON.parse(readFileSync("tests/fixtures/hf-daily-papers.json", "utf-8")),
  );
  const hn = parseSearchResponse(
    JSON.parse(readFileSync("tests/fixtures/hn-recent.json", "utf-8")),
  );
  if (!arxiv.ok || !hf.ok || !hn.ok) throw new Error("fixtures failed to parse");

  const clusters = clusterItems(dedupeWithinSource([...arxiv.value, ...hf.value, ...hn.value]));

  // Fixtures are dated; rank as of the newest item so recency is meaningful.
  const now = new Date(Math.max(...clusters.map((c) => c.primary.publishedAt.getTime())));

  // The corpus is its own trailing window at cold start, per ADR 002.
  const distributions = buildDistributions(clusters, "seeded", now);

  const ranked = rankClusters(clusters, distributions, now);
  const included = ranked.filter((entry) => entry.included);

  console.log(`corpus: ${clusters.length} clusters · ranking as of ${now.toISOString()}\n`);
  console.log(`${"=".repeat(74)}\nTOP 25 (included only)\n${"=".repeat(74)}`);
  included.slice(0, 25).forEach((entry, index) => console.log(line(entry, index)));

  const research = included.filter((e) => e.snapshot.cluster === "research").length;
  const discussion = included.length - research;
  const top25 = included.slice(0, 25);
  const top25Hn = top25.filter((e) => e.snapshot.cluster === "discussion").length;

  console.log(`\n${"=".repeat(74)}`);
  console.log(`included: ${included.length}/${clusters.length}`);
  console.log(`  research: ${research} · discussion: ${discussion}`);
  console.log(`excluded below floor: ${ranked.length - included.length}`);
  console.log(`\ntop 25 interleaving: ${25 - top25Hn} papers, ${top25Hn} HN`);
  console.log(
    `top-25 HN positions: ${top25
      .map((e, i) => (e.snapshot.cluster === "discussion" ? i + 1 : null))
      .filter(Boolean)
      .join(", ")}`,
  );

  const multiSource = included.filter((e) => e.snapshot.sourceCount > 1).length;
  console.log(`two-source papers in feed: ${multiSource}`);
}

main();

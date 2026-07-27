import { readFileSync } from "node:fs";

import { clusterItems, dedupeWithinSource } from "@/lib/pipeline/clustering";
import { parseAtomFeed } from "@/lib/sources/arxiv";
import { parseSearchResponse } from "@/lib/sources/hackernews";
import { parseDailyPapers } from "@/lib/sources/huggingface";

/**
 * Prints clustering behavior over the committed fixtures. Not part of
 * `npm test` — this is for reading the output, not asserting on it.
 * Run with: npx tsx scripts/check-clustering.mts
 */
const arxiv = parseAtomFeed(readFileSync("tests/fixtures/arxiv-recent.xml", "utf-8"));
const hf = parseDailyPapers(
  JSON.parse(readFileSync("tests/fixtures/hf-daily-papers.json", "utf-8")),
);
const hn = parseSearchResponse(JSON.parse(readFileSync("tests/fixtures/hn-recent.json", "utf-8")));
if (!arxiv.ok || !hf.ok || !hn.ok) throw new Error("fixtures failed to parse");

const corpus = [...arxiv.value, ...hf.value, ...hn.value];
const clusters = clusterItems(dedupeWithinSource(corpus));

const multi = clusters.filter((c) => c.sourceCount > 1);
console.log(
  `corpus:   ${corpus.length} items (arXiv ${arxiv.value.length}, HF ${hf.value.length}, HN ${hn.value.length})`,
);
console.log(`clusters: ${clusters.length}`);
console.log(`  multi-source: ${multi.length}`);
console.log(`  single:       ${clusters.length - multi.length}`);
console.log(`\ntop multi-source clusters by upvotes:`);

for (const cluster of multi
  .sort((a, b) => Number(b.primary.signals.upvotes ?? 0) - Number(a.primary.signals.upvotes ?? 0))
  .slice(0, 5)) {
  const kinds = cluster.items.map((i) => i.kind).join("+");
  console.log(
    `  ${String(cluster.primary.signals.upvotes ?? 0).padStart(4)}▲ [${kinds}] ${cluster.primary.title.slice(0, 48)}`,
  );
}

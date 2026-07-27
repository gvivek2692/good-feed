import "dotenv/config";
import { readFileSync } from "node:fs";

import { MODELS } from "@/lib/llm/models";
import { clusterItems, dedupeWithinSource } from "@/lib/pipeline/clustering";
import { summarizeCluster } from "@/lib/pipeline/summarize";
import { parseAtomFeed } from "@/lib/sources/arxiv";
import { parseDailyPapers } from "@/lib/sources/huggingface";

/**
 * Summarizes a few real fixture clusters against the live API and reports
 * whether each claim's quotedFrom actually appears in the source.
 *
 * This is the check mocks cannot make: whether grounded output is what the
 * model actually produces. Not part of `npm test`.
 * Run with: npx tsx scripts/check-summarize.mts
 */
async function main(): Promise<void> {
  const arxiv = parseAtomFeed(readFileSync("tests/fixtures/arxiv-recent.xml", "utf-8"));
  const hf = parseDailyPapers(
    JSON.parse(readFileSync("tests/fixtures/hf-daily-papers.json", "utf-8")),
  );
  if (!arxiv.ok || !hf.ok) throw new Error("fixtures failed to parse");

  const clusters = clusterItems(dedupeWithinSource([...arxiv.value, ...hf.value]))
    .filter((c) => c.sourceCount > 1)
    .sort((a, b) => Number(b.primary.signals.upvotes ?? 0) - Number(a.primary.signals.upvotes ?? 0))
    .slice(0, 3);

  let grounded = 0;
  let ungrounded = 0;

  for (const cluster of clusters) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(cluster.primary.title.slice(0, 68));

    const result = await summarizeCluster(cluster, { maxRetries: 1 });

    if (!result.ok) {
      console.log(`  ERROR: ${JSON.stringify(result.error).slice(0, 160)}`);
      continue;
    }

    const { summary, whyItMatters, claims, quotableSource } = result.value;
    console.log(`\nSUMMARY (${summary.split(/\s+/).length}w): ${summary}`);
    console.log(`\nWHY IT MATTERS: ${whyItMatters}`);
    console.log(`\nCLAIMS: ${claims.length}`);

    for (const claim of claims) {
      // This is exactly what Task 7 will enforce.
      const found = quotableSource.includes(claim.quotedFrom);
      if (found) grounded += 1;
      else ungrounded += 1;
      console.log(`  ${found ? "GROUNDED  " : "UNGROUNDED"} "${claim.text.slice(0, 55)}"`);
      if (!found) console.log(`             quoted: "${claim.quotedFrom.slice(0, 55)}"`);
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`model: ${MODELS.generation}`);
  console.log(`claims grounded: ${grounded}, ungrounded: ${ungrounded}`);
  if (ungrounded > 0) {
    console.log("\nUngrounded claims found — this is precisely what Task 7 must strip.");
  }
}

void main();

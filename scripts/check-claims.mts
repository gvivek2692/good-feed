import "dotenv/config";
import { readFileSync } from "node:fs";

import { validateClaims } from "@/lib/pipeline/claims";
import { clusterItems, dedupeWithinSource } from "@/lib/pipeline/clustering";
import { summarizeCluster } from "@/lib/pipeline/summarize";
import { parseAtomFeed } from "@/lib/sources/arxiv";
import { parseDailyPapers } from "@/lib/sources/huggingface";

/**
 * Runs real model output through the validator and reports what it strips.
 *
 * The unit tests prove the validator strips what it should; this checks the
 * rate at which real takes trip it, which is the number that matters. A high
 * strip rate means the prompt is failing, not that the validator is working.
 * Not part of `npm test`.
 * Run with: npx tsx scripts/check-claims.mts
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
    .slice(0, 5);

  let takesModified = 0;
  let assertionsStripped = 0;

  for (const cluster of clusters) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(cluster.primary.title.slice(0, 68));

    const summarized = await summarizeCluster(cluster, { maxRetries: 1 });
    if (!summarized.ok) {
      console.log(`  ERROR: ${JSON.stringify(summarized.error).slice(0, 160)}`);
      continue;
    }

    const { whyItMatters, claims, quotableSource } = summarized.value;
    const result = validateClaims({ whyItMatters, claims, quotableSource });

    console.log(`\nBEFORE: ${whyItMatters}`);
    if (result.modified) {
      takesModified += 1;
      assertionsStripped += result.rejected.length;
      console.log(`\nAFTER:  ${result.whyItMatters || "(empty — publishes with summary only)"}`);
      for (const rejection of result.rejected) {
        console.log(`  STRIPPED [${rejection.reason}] "${rejection.sentence.slice(0, 60)}"`);
        if (rejection.quotedFrom) {
          console.log(`           quoted: "${rejection.quotedFrom.slice(0, 60)}"`);
        }
      }
    } else {
      console.log(`\nUNCHANGED — ${claims.length} claim(s) verified`);
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`takes modified: ${takesModified}/${clusters.length}`);
  console.log(`assertions stripped: ${assertionsStripped}`);
  if (takesModified > clusters.length / 2) {
    console.log("\nHigh strip rate — suspect the prompt, not the validator.");
  }
}

void main();

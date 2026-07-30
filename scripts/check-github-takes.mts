import "@/lib/env";

import { validateClaims } from "@/lib/pipeline/claims";
import { classifyCluster } from "@/lib/pipeline/topics";
import { summarizeCluster } from "@/lib/pipeline/summarize";
import { fetchArticleText } from "@/lib/sources/article";
import { fetchTrendingRepos } from "@/lib/sources/github";
import { type Cluster } from "@/lib/pipeline/clustering";

/**
 * The G4 gate: generate takes for real trending repos and show what the
 * validator does with them. A repo README is promotional copy, so the question
 * is whether self-assessment reaches the take.
 */
const LIMIT = Number(process.env.LIMIT ?? 10);

const repos = await fetchTrendingRepos({ since: "daily" });
if (!repos.ok) throw new Error(repos.error.message);

let laundered = 0;
let unclassified = 0;
let done = 0;

for (const item of repos.value.slice(0, LIMIT)) {
  // The README is the real source text; the one-line description is too thin.
  const readme = await fetchArticleText(`${item.canonicalUrl}/blob/HEAD/README.md`);
  const sourceText = readme.ok ? readme.value.slice(0, 6000) : (item.text ?? "");

  const enriched = { ...item, text: sourceText };
  const cluster: Cluster = {
    id: `gh-${item.externalId}`,
    items: [enriched],
    sourceCount: 1,
    primary: enriched,
  };

  const summary = await summarizeCluster(cluster);
  if (!summary.ok) {
    console.log(`\n${item.title}\n  SUMMARIZE FAILED: ${summary.error.message}`);
    continue;
  }

  const validated = validateClaims({
    whyItMatters: summary.value.whyItMatters,
    claims: summary.value.claims,
    quotableSource: summary.value.quotableSource,
    sourceIsSelfPromotional: true,
  });

  const topics = await classifyCluster(cluster);
  const slugs = topics.ok ? topics.value.topics.map((t) => t.slug) : [];
  if (slugs.length === 0) unclassified++;

  done++;
  console.log(`\n${"=".repeat(70)}\n${item.title}  (+${item.signals.starsToday} today)`);
  console.log(`topics: ${slugs.join(", ") || "NONE — would be dropped"}`);
  console.log(`headline: ${summary.value.headline}`);
  console.log(`take:     ${validated.whyItMatters || "(emptied by validation)"}`);
  if (validated.rejected.length > 0) {
    console.log(`STRIPPED ${validated.rejected.length}:`);
    for (const r of validated.rejected) {
      laundered++;
      console.log(`  - [${r.reason}] ${r.sentence}`);
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
}

console.log(`\n${"=".repeat(70)}`);
console.log(`repos:        ${done}`);
console.log(`unclassified: ${unclassified} (would be dropped as unreachable)`);
console.log(`assertions stripped: ${laundered}`);

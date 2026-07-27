import "dotenv/config";

import * as arxiv from "@/lib/sources/arxiv";
import * as hn from "@/lib/sources/hackernews";

/**
 * Manual smoke check against the live APIs. Not part of `npm test` — the suite
 * runs offline against fixtures. Run with: npx tsx scripts/check-sources.mts
 */
async function main(): Promise<void> {
  const since = new Date(Date.now() - 14 * 24 * 3_600_000);

  const a = await arxiv.fetchRecent({ since, limit: 10 });
  console.log("arXiv:", a.ok ? `${a.value.length} items` : `ERROR ${JSON.stringify(a.error)}`);
  if (a.ok && a.value[0]) {
    const item = a.value[0];
    console.log("  ", item.title.slice(0, 65));
    console.log("   authors:", item.authors.length, "| repo:", item.signals.repoUrl ?? "none");
  }

  const h = await hn.fetchRecent({ since, limit: 30 });
  console.log("HN:", h.ok ? `${h.value.length} unique items` : `ERROR ${JSON.stringify(h.error)}`);
  if (h.ok) {
    for (const item of h.value.slice(0, 3)) {
      console.log(`   ${String(item.signals.points).padStart(4)}pts ${item.title.slice(0, 55)}`);
    }
  }
}

void main();

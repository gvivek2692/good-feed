import "@/lib/env";

import { fetchTrendingRepos } from "@/lib/sources/github";
import { fetchRecent } from "@/lib/sources/hackernews";

/**
 * Measures how often a trending repo is also on Hacker News. ADR 001 found 16
 * of 64 HN stories linked to GitHub, which makes duplicate items a real risk
 * rather than a theoretical one.
 */
const since = new Date(Date.now() - 7 * 86_400_000);

const [repos, hn] = await Promise.all([
  fetchTrendingRepos({ since: "weekly" }),
  fetchRecent({ since }),
]);

if (!repos.ok) throw new Error(`trending failed: ${repos.error.message}`);
if (!hn.ok) throw new Error(`hn failed: ${hn.error.message}`);

console.log(`trending repos: ${repos.value.length}`);
console.log(`hn stories:     ${hn.value.length}`);

/** github.com/{owner}/{name}, lowercased, ignoring /blob/, /tree/, .git, trailing slash. */
function repoSlug(url: string): string | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)/i.exec(url);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, "")}`.toLowerCase();
}

const hnRepos = new Map<string, string>();
for (const story of hn.value) {
  const slug = repoSlug(story.canonicalUrl);
  if (slug) hnRepos.set(slug, story.title);
}

console.log(`hn stories linking a repo: ${hnRepos.size}`);

let overlaps = 0;
for (const repo of repos.value) {
  const slug = repo.title.toLowerCase();
  if (hnRepos.has(slug)) {
    overlaps++;
    console.log(`  OVERLAP ${repo.title}`);
    console.log(`    hn: ${hnRepos.get(slug)}`);
  }
}

console.log(`\noverlapping repos: ${overlaps} of ${repos.value.length}`);

// Print both sides so a zero result can be checked rather than trusted.
console.log("\ntrending slugs:");
for (const r of repos.value) console.log(`  ${r.title.toLowerCase()}`);
console.log("\nhn repo slugs:");
for (const [slug] of hnRepos) console.log(`  ${slug}`);

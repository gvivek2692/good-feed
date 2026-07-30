import "@/lib/env";

import { fetchTrendingRepos } from "@/lib/sources/github";

/**
 * Live check against github.com/trending. Not part of `npm test` — the unit
 * suite runs offline against the captured fixture.
 */
const result = await fetchTrendingRepos({ since: "daily" });

if (!result.ok) {
  console.error(`FAILED: ${result.error.kind} — ${result.error.message}`);
  process.exit(1);
}

console.log(`${result.value.length} trending repos\n`);
for (const item of result.value) {
  const s = item.signals;
  console.log(`  ${item.title}`);
  console.log(
    `    +${s.starsToday} today · ${s.stars} total · ${s.forks} forks · ${s.language ?? "—"}`,
  );
  console.log(`    ${item.text ? item.text.slice(0, 88) : "(no description)"}`);
}

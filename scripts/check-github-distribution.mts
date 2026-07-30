import "@/lib/env";

import { fetchTrendingRepos } from "@/lib/sources/github";

/**
 * Measures the starsToday distribution so the code cluster's weights and floor
 * are justified by data rather than guessed. ADR 002's rule: a floor that is
 * not measured must say so.
 */
const windows = ["daily", "weekly"] as const;

for (const since of windows) {
  const result = await fetchTrendingRepos({ since });
  if (!result.ok) {
    console.error(`${since}: ${result.error.message}`);
    continue;
  }

  const starsToday = result.value
    .map((item) => Number(item.signals.starsToday))
    .sort((a, b) => a - b);
  const stars = result.value.map((item) => Number(item.signals.stars)).sort((a, b) => a - b);
  const forks = result.value.map((item) => Number(item.signals.forks)).sort((a, b) => a - b);

  const pct = (arr: number[], p: number): number => arr[Math.floor((arr.length - 1) * p)];

  console.log(`\n=== ${since} (n=${result.value.length}) ===`);
  for (const [name, arr] of [
    ["starsToday", starsToday],
    ["stars", stars],
    ["forks", forks],
  ] as const) {
    console.log(
      `${name.padEnd(11)} min=${arr[0]} p25=${pct(arr, 0.25)} p50=${pct(arr, 0.5)} ` +
        `p75=${pct(arr, 0.75)} p90=${pct(arr, 0.9)} max=${arr[arr.length - 1]}`,
    );
  }

  const distinct = new Set(starsToday).size;
  console.log(`starsToday distinct values: ${distinct} of ${starsToday.length}`);
  console.log(`repos with description: ${result.value.filter((i) => i.text).length}`);
}

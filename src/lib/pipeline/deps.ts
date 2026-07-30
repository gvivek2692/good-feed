import { classifyCluster } from "@/lib/pipeline/topics";
import { summarizeCluster } from "@/lib/pipeline/summarize";
import { type PipelineDeps } from "@/lib/pipeline/runner";
import { fetchArticleText } from "@/lib/sources/article";
import { fetchRecent as fetchArxiv } from "@/lib/sources/arxiv";
import { fetchTrendingRepos } from "@/lib/sources/github";
import { fetchRecent as fetchHackerNews } from "@/lib/sources/hackernews";
import { fetchRecent as fetchHuggingFace } from "@/lib/sources/huggingface";
import { ok, type Result } from "@/lib/result";
import { type NormalizedItem, type SourceError } from "@/lib/sources/types";

/** A repo's README is the only text substantial enough to summarize from. */
const MAX_README_CHARS = 6_000;

/**
 * Replaces each repo's one-line description with its README.
 *
 * The trending page gives a single sentence, which produced the same failure HN
 * link posts did: a summary with nothing behind it. A repo whose README cannot
 * be fetched keeps its description rather than being dropped — thin but honest
 * beats absent.
 */
async function withReadmes(
  result: Result<NormalizedItem[], SourceError>,
): Promise<Result<NormalizedItem[], SourceError>> {
  if (!result.ok) return result;

  const enriched = await Promise.all(
    result.value.map(async (item) => {
      const readme = await fetchArticleText(`${item.canonicalUrl}/blob/HEAD/README.md`);
      if (!readme.ok) return item;
      return { ...item, text: readme.value.slice(0, MAX_README_CHARS) };
    }),
  );

  return ok(enriched);
}

export interface LiveDepsOptions {
  /** How far back to fetch. Defaults to 3 days. */
  since?: Date;
  limit?: number;
  /** Pause between items. Defaults to 6s, which the free tier tolerates. */
  itemDelayMs?: number;
  maxItems?: number;
}

/**
 * The production wiring: real adapters, real Gemini calls.
 *
 * Kept separate from the runner so tests can substitute the whole set without
 * a network stub, and so the runner has no import path to a live API.
 */
export function liveDeps(options: LiveDepsOptions = {}): PipelineDeps {
  const since = options.since ?? new Date(Date.now() - 3 * 86_400_000);
  const limit = options.limit ?? 100;

  return {
    // Sources are fetched concurrently and reported individually, so one
    // failing source costs its own items rather than the whole run.
    fetchSources: () =>
      Promise.all([
        fetchArxiv({ since, limit }),
        fetchHuggingFace({ since, limit }),
        fetchHackerNews({ since, limit }),
        // Daily, not weekly: the absolute floor of 50 starsToday is calibrated
        // against the daily distribution, and the weekly page is a different
        // scale entirely (min=996, p50=2892).
        fetchTrendingRepos({ since: "daily" }).then(withReadmes),
      ]),
    summarize: (cluster) => summarizeCluster(cluster),
    classify: (cluster) => classifyCluster(cluster),
    now: () => new Date(),
    itemDelayMs: options.itemDelayMs ?? 6_000,
    maxItems: options.maxItems,
  };
}

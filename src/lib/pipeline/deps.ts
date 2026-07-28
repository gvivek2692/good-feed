import { classifyCluster } from "@/lib/pipeline/topics";
import { summarizeCluster } from "@/lib/pipeline/summarize";
import { type PipelineDeps } from "@/lib/pipeline/runner";
import { fetchRecent as fetchArxiv } from "@/lib/sources/arxiv";
import { fetchRecent as fetchHackerNews } from "@/lib/sources/hackernews";
import { fetchRecent as fetchHuggingFace } from "@/lib/sources/huggingface";

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
      ]),
    summarize: (cluster) => summarizeCluster(cluster),
    classify: (cluster) => classifyCluster(cluster),
    now: () => new Date(),
    itemDelayMs: options.itemDelayMs ?? 6_000,
    maxItems: options.maxItems,
  };
}

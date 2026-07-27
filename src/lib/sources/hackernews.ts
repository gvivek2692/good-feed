import { z } from "zod";

import { err, ok, type Result } from "@/lib/result";
import { type FetchOptions, type NormalizedItem, type SourceError } from "@/lib/sources/types";

const HN_SEARCH_API = "https://hn.algolia.com/api/v1/search_by_date";

/**
 * Terms scoping HN to AI content. HN has no topical tag, so keyword search is
 * the only available filter.
 *
 * Each term is queried separately and the results merged. Algolia does NOT
 * support boolean OR in `query` — it treats "AI OR LLM" as a phrase and matches
 * titles literally containing "AI or LLM", which returns almost nothing.
 * Verified against the live API.
 */
const AI_TERMS = ["AI", "LLM", "GPT", "transformer", "neural network", "diffusion model"] as const;

/** Below this, a story has no meaningful discussion signal. */
const MIN_POINTS = 10;

/**
 * Algolia returns many fields; we validate only what we use and let the rest
 * through untouched into `raw`. `url` is null for Ask HN and text posts.
 */
const HnHit = z.object({
  objectID: z.string(),
  title: z.string().nullable(),
  url: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  points: z.number().nullable().optional(),
  num_comments: z.number().nullable().optional(),
  created_at: z.string(),
  story_text: z.string().nullable().optional(),
});

const HnResponse = z.object({
  hits: z.array(z.unknown()),
});

function normalizeHit(raw: unknown): NormalizedItem | null {
  const parsed = HnHit.safeParse(raw);
  if (!parsed.success) return null;

  const hit = parsed.data;
  const title = hit.title?.trim();
  if (!title) return null;

  const publishedAt = new Date(hit.created_at);
  if (Number.isNaN(publishedAt.getTime())) return null;

  const hnUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;
  const points = hit.points ?? 0;
  const comments = hit.num_comments ?? 0;

  // Hours since publication, floored at 1 so brand-new stories do not divide
  // by ~0 and produce enormous velocities.
  const ageHours = Math.max(1, (Date.now() - publishedAt.getTime()) / 3_600_000);

  return {
    externalId: hit.objectID,
    kind: "HACKERNEWS",
    title,
    authors: hit.author ? [hit.author] : [],
    publishedAt,
    // Ask HN and text posts have no external link; the thread is the item.
    canonicalUrl: hit.url ?? hnUrl,
    sourceUrl: hnUrl,
    text: hit.story_text?.trim() || null,
    // HN occasionally links straight to arXiv. Measured at 0/64 in the
    // fixture corpus, so this is opportunistic rather than load-bearing.
    arxivId: /arxiv\.org\/(?:abs|pdf)\/([\d.]+)/.exec(hit.url ?? "")?.[1] ?? null,
    signals: {
      points,
      comments,
      pointsPerHour: Number((points / ageHours).toFixed(4)),
      commentsPerHour: Number((comments / ageHours).toFixed(4)),
      isTextPost: hit.url ? "false" : "true",
    },
    raw,
  };
}

/**
 * Parses an Algolia search response. Exported so tests can exercise parsing
 * against fixtures without any network involvement.
 */
export function parseSearchResponse(body: unknown): Result<NormalizedItem[], SourceError> {
  const parsed = HnResponse.safeParse(body);
  if (!parsed.success) {
    return err({
      kind: "parse",
      message: "HN response had no hits array",
      detail: parsed.error.issues,
    });
  }

  // Individual malformed hits are dropped rather than failing the batch —
  // one bad record should not cost us the other 99.
  const items = parsed.data.hits
    .map(normalizeHit)
    .filter((item): item is NormalizedItem => item !== null);

  return ok(items);
}

/** Runs one term's query. Exported for testing a single request in isolation. */
export async function fetchTerm(
  term: string,
  options: FetchOptions,
): Promise<Result<NormalizedItem[], SourceError>> {
  const { since, limit = 100, fetchImpl = fetch } = options;

  const query = new URLSearchParams({
    query: term,
    tags: "story",
    hitsPerPage: String(limit),
    numericFilters: [
      `created_at_i>${Math.floor(since.getTime() / 1000)}`,
      `points>=${MIN_POINTS}`,
    ].join(","),
  });

  let response: Response;
  try {
    response = await fetchImpl(`${HN_SEARCH_API}?${query.toString()}`);
  } catch (cause) {
    return err({
      kind: "network",
      message: cause instanceof Error ? cause.message : "HN request failed",
    });
  }

  if (!response.ok) {
    return err({
      kind: "http",
      status: response.status,
      message: `HN returned ${response.status}`,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    return err({ kind: "parse", message: "HN response was not valid JSON", detail: cause });
  }

  return parseSearchResponse(body);
}

export async function fetchRecent(
  options: FetchOptions,
): Promise<Result<NormalizedItem[], SourceError>> {
  const perTermLimit = Math.ceil((options.limit ?? 100) / AI_TERMS.length);

  const results = await Promise.all(
    AI_TERMS.map((term) => fetchTerm(term, { ...options, limit: perTermLimit })),
  );

  // One term failing should not lose the other five. Only a total failure is
  // reported as an error.
  const successes = results.filter((r) => r.ok);
  if (successes.length === 0) {
    const firstError = results.find((r) => !r.ok);
    return firstError ?? err({ kind: "network", message: "no HN queries succeeded" });
  }

  // Terms overlap heavily — a story about "GPT" usually also matches "AI".
  const byId = new Map<string, NormalizedItem>();
  for (const result of successes) {
    for (const item of result.value) {
      byId.set(item.externalId, item);
    }
  }

  return ok([...byId.values()].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime()));
}

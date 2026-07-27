import { z } from "zod";

import { err, ok, type Result } from "@/lib/result";
import { type FetchOptions, type NormalizedItem, type SourceError } from "@/lib/sources/types";

const HF_DAILY_PAPERS_API = "https://huggingface.co/api/daily_papers";

/**
 * HuggingFace Papers exists in this pipeline to supply the cross-source join
 * that arXiv and Hacker News cannot form with each other.
 *
 * Measured over 14 days: 245 papers, 56% carrying a GitHub repo (vs 4.4% on raw
 * arXiv), 37% joining to the arXiv corpus by id. See docs/adr/001.
 *
 * It is a *curated funnel*, not a comprehensive source — roughly 17 papers/day
 * against arXiv's ~143. Absence from HF is not evidence a paper is unimportant.
 */
const HfPaper = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  upvotes: z.number().nullable().optional(),
  githubRepo: z.string().nullable().optional(),
  githubStars: z.number().nullable().optional(),
  authors: z
    .array(z.object({ name: z.string().nullable().optional() }))
    .nullable()
    .optional(),
});

const HfEntry = z.object({
  paper: HfPaper,
  publishedAt: z.string().nullable().optional(),
  numComments: z.number().nullable().optional(),
});

/** Strips a trailing version suffix so v1 and v2 join to the same cluster. */
function normalizeArxivId(id: string): string {
  return id.trim().replace(/v\d+$/, "");
}

function normalizeEntry(raw: unknown): NormalizedItem | null {
  const parsed = HfEntry.safeParse(raw);
  if (!parsed.success) return null;

  const { paper, numComments } = parsed.data;
  const title = paper.title?.trim();
  if (!title) return null;

  const arxivId = normalizeArxivId(paper.id);
  if (!arxivId) return null;

  const published = paper.publishedAt ?? parsed.data.publishedAt;
  const publishedAt = published ? new Date(published) : null;
  if (!publishedAt || Number.isNaN(publishedAt.getTime())) return null;

  const authors = (paper.authors ?? [])
    .map((a) => a?.name?.trim())
    .filter((name): name is string => Boolean(name));

  // Normalized to "owner/repo" so it can be compared against HN's GitHub links.
  const repoUrl = paper.githubRepo?.trim() || null;
  const repoSlug = repoUrl
    ? (/github\.com\/([\w.-]+\/[\w.-]+)/i
        .exec(repoUrl)?.[1]
        ?.toLowerCase()
        .replace(/\.git$/, "") ?? null)
    : null;

  return {
    externalId: arxivId,
    kind: "HUGGINGFACE",
    title,
    authors,
    publishedAt,
    canonicalUrl: `https://arxiv.org/abs/${arxivId}`,
    sourceUrl: `https://huggingface.co/papers/${arxivId}`,
    text: paper.summary?.replace(/\s+/g, " ").trim() || null,
    arxivId,
    signals: {
      upvotes: paper.upvotes ?? 0,
      comments: numComments ?? 0,
      githubStars: paper.githubStars ?? null,
      repoUrl,
      repoSlug,
    },
    raw,
  };
}

/**
 * Parses a daily_papers response. Exported so tests can exercise parsing
 * against fixtures without any network involvement.
 */
export function parseDailyPapers(body: unknown): Result<NormalizedItem[], SourceError> {
  if (!Array.isArray(body)) {
    return err({ kind: "parse", message: "HuggingFace response was not an array" });
  }

  // Individual malformed entries are dropped rather than failing the batch.
  const items = body.map(normalizeEntry).filter((item): item is NormalizedItem => item !== null);

  return ok(items);
}

/** Fetches one day. The API is day-scoped; there is no range parameter. */
export async function fetchDay(
  date: Date,
  options: Pick<FetchOptions, "fetchImpl">,
): Promise<Result<NormalizedItem[], SourceError>> {
  const { fetchImpl = fetch } = options;
  const day = date.toISOString().slice(0, 10);

  let response: Response;
  try {
    response = await fetchImpl(`${HF_DAILY_PAPERS_API}?date=${day}&limit=100`);
  } catch (cause) {
    return err({
      kind: "network",
      message: cause instanceof Error ? cause.message : "HuggingFace request failed",
    });
  }

  if (!response.ok) {
    return err({
      kind: "http",
      status: response.status,
      message: `HuggingFace returned ${response.status}`,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    return err({
      kind: "parse",
      message: "HuggingFace response was not valid JSON",
      detail: cause,
    });
  }

  return parseDailyPapers(body);
}

export async function fetchRecent(
  options: FetchOptions,
): Promise<Result<NormalizedItem[], SourceError>> {
  const { since, fetchImpl } = options;

  // One request per day between `since` and today, capped so a stale `since`
  // cannot trigger hundreds of requests.
  const days: Date[] = [];
  const cursor = new Date(since);
  cursor.setUTCHours(0, 0, 0, 0);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  while (cursor <= today && days.length < 30) {
    days.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const results = await Promise.all(days.map((day) => fetchDay(day, { fetchImpl })));

  // One day failing should not lose the rest; only a total failure is an error.
  const successes = results.filter((r) => r.ok);
  if (successes.length === 0) {
    return results.find((r) => !r.ok) ?? err({ kind: "network", message: "no HF days succeeded" });
  }

  // The same paper can appear on several days while it trends.
  const byId = new Map<string, NormalizedItem>();
  for (const result of successes) {
    for (const item of result.value) {
      const existing = byId.get(item.externalId);
      // Keep whichever snapshot saw more upvotes.
      if (!existing || Number(item.signals.upvotes) > Number(existing.signals.upvotes)) {
        byId.set(item.externalId, item);
      }
    }
  }

  return ok([...byId.values()].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime()));
}

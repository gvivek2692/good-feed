import { err, ok, type Result } from "@/lib/result";
import { type NormalizedItem, type SourceError } from "@/lib/sources/types";

/**
 * GitHub trending repositories.
 *
 * There is no JSON API for trending — `api.github.com/trending` is 404. The
 * only source is the server-rendered HTML at github.com/trending, which is not
 * disallowed by robots.txt and carries the momentum figure directly as
 * "N stars today". GitHub computes trending for us, so no star-history table
 * and no warm-up period are needed.
 *
 * The page is unversioned markup with no stability contract, which is the real
 * risk here: a restyle would silently yield zero repos, and a source returning
 * nothing looks exactly like a quiet day. `fetchTrendingRepos` therefore treats
 * "fetched a page but parsed no rows" as an error, never as an empty success.
 *
 * The list is all of GitHub, not AI — measured 3 of 14 rows AI-related. This
 * adapter deliberately does not filter: the topic classifier already decides
 * whether an item belongs in one of the 15 topics, and the runner already drops
 * what it cannot place. A keyword regex here would be a second, worse
 * classifier maintained in parallel.
 */

const TRENDING_URL = "https://github.com/trending";
const TIMEOUT_MS = 15_000;

/** Rows are `<article class="Box-row">`; splitting on it is the row boundary. */
const ROW_DELIMITER = /<article class="Box-row"/;

/**
 * `owner/name` from the row's heading link. The `<h2>` contains an anchor whose
 * href is the repo path; attributes intervene, hence the non-greedy span.
 */
const REPO_PATH = /<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^/"]+)\/([^/"]+)"/;

/** Stable numeric id, embedded in the row's star-button telemetry payload. */
const REPOSITORY_ID = /repository_id&quot;:(\d+)/;

/** The momentum signal. "N stars today", or "N stars this week" on ?since=weekly. */
const STARS_PERIOD = /([\d,]+)\s*stars?\s*(?:today|this week|this month)/;

/** Counts follow an inline SVG inside the link, so the pattern spans it. */
const TOTAL_STARS = /href="\/[^"]+\/stargazers"[\s\S]*?<\/svg>\s*([\d,]+)/;
const FORKS = /href="\/[^"]+\/forks"[\s\S]*?<\/svg>\s*([\d,]+)/;

const DESCRIPTION = /<p class="col-9[^"]*">\s*([\s\S]*?)\s*<\/p>/;
const LANGUAGE = /itemprop="programmingLanguage">([^<]+)</;

export type TrendingWindow = "daily" | "weekly" | "monthly";

export interface GithubFetchOptions {
  since?: TrendingWindow;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injectable so `publishedAt` is deterministic in tests. */
  now?: Date;
}

function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toNumber(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw.replace(/,/g, ""), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Parses one row into a NormalizedItem, or null when the row lacks the fields
 * that make it usable. A row without a repo path or an id is not a repo we can
 * identify, so it is skipped rather than guessed at.
 */
export function parseTrendingRow(row: string, now: Date): NormalizedItem | null {
  const path = REPO_PATH.exec(row);
  if (!path) return null;

  const owner = path[1];
  const name = path[2];
  const fullName = `${owner}/${name}`;

  // The numeric id is the externalId: a repo can be renamed, and the name is
  // therefore not stable enough to dedupe on across runs.
  const id = REPOSITORY_ID.exec(row);
  if (!id) return null;

  const starsToday = toNumber(STARS_PERIOD.exec(row)?.[1]);
  const stars = toNumber(TOTAL_STARS.exec(row)?.[1]);
  const forks = toNumber(FORKS.exec(row)?.[1]);
  const description = DESCRIPTION.exec(row)?.[1];
  const language = LANGUAGE.exec(row)?.[1]?.trim() ?? null;
  const text = description ? decodeEntities(description) : null;

  return {
    externalId: id[1],
    kind: "GITHUB",
    title: fullName,
    // A repo has no author list in the paper sense. The owner is the closest
    // honest equivalent and is what a reader would recognise.
    authors: [owner],
    // The page gives no publish date. Trending is a statement about *now*, so
    // the fetch time is the honest timestamp — a repo's creation date would
    // make a 2014 repo look stale when its point is that it is spiking today.
    publishedAt: now,
    canonicalUrl: `https://github.com/${fullName}`,
    sourceUrl: TRENDING_URL,
    text,
    // Repos never join the research cluster; that join is arXiv-id only.
    arxivId: null,
    signals: { starsToday, stars, forks, language },
    raw: { fullName, owner, name, repositoryId: id[1], starsToday, stars, forks, language, text },
  };
}

/**
 * Fetches and parses the trending page.
 *
 * Returns an error rather than throwing so a GitHub failure degrades to the
 * other sources instead of failing the whole run.
 */
export async function fetchTrendingRepos(
  options: GithubFetchOptions = {},
): Promise<Result<NormalizedItem[], SourceError>> {
  const { since = "daily", fetchImpl = fetch, timeoutMs = TIMEOUT_MS, now = new Date() } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${TRENDING_URL}?since=${since}`, {
      signal: controller.signal,
      headers: {
        "user-agent": "good-feed/0.1 (+https://github.com/gvivek2692/good-feed)",
        accept: "text/html",
      },
    });

    if (!response.ok) {
      return err({
        kind: "http",
        status: response.status,
        message: `github trending returned ${response.status}`,
      });
    }

    const html = await response.text();
    const rows = html.split(ROW_DELIMITER).slice(1);

    // A structural change to the page must fail loudly. An empty array here
    // would be indistinguishable from "nothing is trending", which never
    // happens, and would quietly remove this source from the feed.
    if (rows.length === 0) {
      return err({
        kind: "parse",
        message:
          "github trending page contained no repository rows — the page markup has likely changed",
      });
    }

    const items = rows
      .map((row) => parseTrendingRow(row, now))
      .filter((item): item is NormalizedItem => item !== null);

    if (items.length === 0) {
      return err({
        kind: "parse",
        message: `github trending: ${rows.length} rows found but none could be parsed — markup has likely changed`,
      });
    }

    return ok(items);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err({ kind: "network", message: `${message} (github trending)` });
  } finally {
    clearTimeout(timer);
  }
}

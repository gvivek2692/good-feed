import { prisma } from "@/lib/db/client";
import { type SignalSnapshot } from "@/lib/ranking/score";

export interface FeedClaim {
  id: string;
  text: string;
  quotedFrom: string;
  sourceUrl: string;
}

export interface FeedItem {
  id: string;
  /** Generated headline; null when it failed validation, so `title` is used. */
  headline: string | null;
  title: string;
  authors: string[];
  publishedAt: Date;
  canonicalUrl: string;
  summary: string | null;
  whyItMatters: string | null;
  importanceScore: number | null;
  sourceKind: string;
  topics: Array<{ slug: string; label: string; confidence: number }>;
  claims: FeedClaim[];
  snapshot: SignalSnapshot | null;
}

export interface FeedQuery {
  /** Restrict to these topic slugs. Empty or absent means all topics. */
  topics?: string[];
  limit?: number;
}

/** The shape every feed query selects, so one mapper serves all of them. */
type ItemRow = {
  id: string;
  headline: string | null;
  title: string;
  authors: string[];
  publishedAt: Date;
  canonicalUrl: string;
  summary: string | null;
  whyItMatters: string | null;
  importanceScore: number | null;
  signalSnapshot: unknown;
  source: { kind: string };
  topics: Array<{ confidence: number; topic: { slug: string; label: string } }>;
  claims: Array<{ id: string; text: string; quotedFrom: string; sourceUrl: string }>;
};

function toFeedItem(row: ItemRow): FeedItem {
  return {
    id: row.id,
    headline: row.headline,
    title: row.title,
    authors: row.authors,
    publishedAt: row.publishedAt,
    canonicalUrl: row.canonicalUrl,
    summary: row.summary,
    whyItMatters: row.whyItMatters,
    importanceScore: row.importanceScore,
    sourceKind: row.source.kind,
    topics: row.topics.map((entry) => ({
      slug: entry.topic.slug,
      label: entry.topic.label,
      confidence: entry.confidence,
    })),
    claims: row.claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      quotedFrom: claim.quotedFrom,
      sourceUrl: claim.sourceUrl,
    })),
    snapshot: (row.signalSnapshot as SignalSnapshot | null) ?? null,
  };
}

/**
 * Reads the ranked feed.
 *
 * Ordering is `importanceScore` descending — the ranking stage already decided
 * this, and the spec forbids the UI reordering by recency or anything else.
 * Only published items appear: unclassified and below-floor items were dropped
 * at ingest and must not resurface here.
 */
export async function getFeedItems(query: FeedQuery = {}): Promise<FeedItem[]> {
  const { topics, limit = 50 } = query;

  const rows = await prisma.item.findMany({
    where: {
      published: true,
      ...(topics && topics.length > 0
        ? { topics: { some: { topic: { slug: { in: topics } } } } }
        : {}),
    },
    orderBy: { importanceScore: "desc" },
    take: limit,
    include: {
      claims: true,
      source: { select: { kind: true } },
      topics: { include: { topic: true } },
    },
  });

  return rows.map(toFeedItem);
}

/** One published item with everything the deep-dive page needs. */
export async function getFeedItem(id: string): Promise<FeedItem | null> {
  const row = await prisma.item.findFirst({
    where: { id, published: true },
    include: {
      claims: true,
      source: { select: { kind: true } },
      topics: { include: { topic: true } },
    },
  });

  if (!row) return null;

  return toFeedItem(row);
}

/** Topics that actually have published items, with counts, for the filter bar. */
export async function getTopicsWithCounts(): Promise<
  Array<{ slug: string; label: string; count: number }>
> {
  const topics = await prisma.topic.findMany({
    include: {
      _count: { select: { items: { where: { item: { published: true } } } } },
    },
  });

  return topics
    .map((topic) => ({ slug: topic.slug, label: topic.label, count: topic._count.items }))
    .filter((topic) => topic.count > 0)
    .sort((a, b) => b.count - a.count);
}

export interface FeedStats {
  published: number;
  lastRunAt: Date | null;
  droppedLastRun: number;
}

/** Headline numbers, so the feed can say where its contents came from. */
export async function getFeedStats(): Promise<FeedStats> {
  const [published, lastRun] = await Promise.all([
    prisma.item.count({ where: { published: true } }),
    prisma.pipelineRun.findFirst({
      where: { status: "COMPLETED" },
      orderBy: { startedAt: "desc" },
    }),
  ]);

  const counts = (lastRun?.stageCounts ?? {}) as Record<string, number>;

  return {
    published,
    lastRunAt: lastRun?.finishedAt ?? null,
    droppedLastRun: counts.dropped ?? 0,
  };
}

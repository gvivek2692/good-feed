import Link from "next/link";

import { AuthNav } from "@/components/auth-nav";
import { FeedItemCard } from "@/components/feed-item-card";
import { getSessionUserId } from "@/lib/auth/session";
import { getFeedItems, getFeedStats, getTopicsWithCounts } from "@/lib/db/feed";
import { EMPTY_INTERACTIONS, getItemInteractions } from "@/lib/db/interactions";

/**
 * The feed.
 *
 * Reads directly from the database in a Server Component — no API route in
 * between, since nothing else consumes this data yet. Topic filtering is a
 * query parameter rather than stored state until Task 12 adds accounts.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ topic?: string }>;
}): Promise<React.ReactElement> {
  const { topic } = await searchParams;
  const selected = topic ? [topic] : undefined;

  const [items, topics, stats, userId] = await Promise.all([
    getFeedItems({ topics: selected }),
    getTopicsWithCounts(),
    getFeedStats(),
    getSessionUserId(),
  ]);

  // Read/saved state needs the item ids, so it is a second query rather than
  // part of the batch above.
  const interactions = userId
    ? await getItemInteractions(
        userId,
        items.map((item) => item.id),
      )
    : EMPTY_INTERACTIONS;

  return (
    <div className="min-h-full bg-white dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <div className="flex items-start justify-between gap-4">
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
              good-feed
            </h1>
            <AuthNav />
          </div>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            What happened in AI research and engineering — and why it matters.
          </p>
          <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-500">
            {stats.published} items
            {stats.lastRunAt ? (
              <> · last ingest {stats.lastRunAt.toISOString().slice(0, 16).replace("T", " ")}</>
            ) : null}
            {stats.droppedLastRun > 0 ? <> · {stats.droppedLastRun} dropped that run</> : null}
          </p>
        </div>
      </header>

      <nav className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex max-w-3xl flex-wrap gap-2 px-6 py-3">
          <Link
            href="/"
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              !topic
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
            }`}
          >
            All
          </Link>
          {topics.map((entry) => (
            <Link
              key={entry.slug}
              href={`/?topic=${entry.slug}`}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                topic === entry.slug
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
              }`}
            >
              {entry.label} <span className="opacity-60">{entry.count}</span>
            </Link>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-3xl px-6">
        {items.length === 0 ? (
          /*
           * A quiet week produces a short feed, by design — the spec forbids
           * padding to hit a count. An empty feed says so rather than
           * apologising for it.
           */
          <p className="py-16 text-center text-sm text-zinc-500 dark:text-zinc-400">
            Nothing cleared the bar{topic ? " for this topic" : ""} yet.
          </p>
        ) : (
          items.map((item) => (
            <FeedItemCard
              key={item.id}
              item={item}
              isRead={interactions.read.has(item.id)}
              isSaved={interactions.saved.has(item.id)}
              signedIn={userId !== null}
            />
          ))
        )}
      </main>

      <footer className="mx-auto max-w-3xl px-6 py-10 text-xs text-zinc-400 dark:text-zinc-600">
        Ranked by observable signals, not by an LLM. Every comparative claim quotes its source.
      </footer>
    </div>
  );
}

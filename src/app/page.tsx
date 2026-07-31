import Link from "next/link";

import { FeedItemCard } from "@/components/feed-item-card";
import { getFeedItems, getFeedStats, getTopicsWithCounts } from "@/lib/db/feed";

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

  const [items, topics, stats] = await Promise.all([
    getFeedItems({ topics: selected }),
    getTopicsWithCounts(),
    getFeedStats(),
  ]);

  return (
    <div className="min-h-full bg-white dark:bg-zinc-950">
      <header className="border-b border-zinc-200/70 dark:border-zinc-800/70">
        <div className="mx-auto max-w-2xl px-6 pb-7 pt-12">
          <h1 className="text-[2rem] font-semibold tracking-[-0.03em] text-zinc-900 dark:text-zinc-50">
            good&#8203;<span className="text-zinc-400 dark:text-zinc-600">/</span>feed
          </h1>
          <p className="mt-2 max-w-md text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-400">
            What happened in AI research and engineering — and why it matters.
          </p>
          <p className="mt-4 font-mono text-[11px] uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
            {stats.published} items
            {stats.lastRunAt ? <> · updated {stats.lastRunAt.toISOString().slice(0, 10)}</> : null}
          </p>
        </div>
      </header>

      {/*
        One scrolling row rather than three wrapped ones. Fourteen topics wrapped
        to three rows on desktop and six on mobile, so a reader scrolled past a
        control bar to reach the first item.
      */}
      <nav className="sticky top-0 z-10 border-b border-zinc-200/70 bg-white/85 backdrop-blur-md dark:border-zinc-800/70 dark:bg-zinc-950/85">
        <div className="mx-auto max-w-2xl px-6">
          <div className="scrollbar-none flex gap-1.5 overflow-x-auto py-3">
            <Link
              href="/"
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                !topic
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
            >
              All
            </Link>
            {topics.map((entry) => (
              <Link
                key={entry.slug}
                href={`/?topic=${entry.slug}`}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  topic === entry.slug
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {entry.label}{" "}
                <span className={topic === entry.slug ? "opacity-60" : "text-zinc-400"}>
                  {entry.count}
                </span>
              </Link>
            ))}
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-2xl px-6">
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
          items.map((item) => <FeedItemCard key={item.id} item={item} />)
        )}
      </main>

      <footer className="mx-auto max-w-2xl border-t border-zinc-200/70 px-6 py-10 text-xs leading-relaxed text-zinc-400 dark:border-zinc-800/70 dark:text-zinc-600">
        Ranked by observable signals, not by an LLM. Every comparative claim quotes its source.
      </footer>
    </div>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";

import { FeedItemCard } from "@/components/feed-item-card";
import { getSessionUserId } from "@/lib/auth/session";
import { getFeedItemsByIds } from "@/lib/db/feed";
import { getItemInteractions, getSavedItemIds } from "@/lib/db/interactions";

/**
 * Saved items, newest save first.
 *
 * Deliberately not ranked by importance: the user already made the selection,
 * and re-sorting their own list by our score would override that judgment.
 */
export default async function SavedPage(): Promise<React.ReactElement> {
  const userId = await getSessionUserId();
  if (!userId) redirect("/signin");

  const savedIds = await getSavedItemIds(userId);
  const [items, interactions] = await Promise.all([
    getFeedItemsByIds(savedIds),
    getItemInteractions(userId, savedIds),
  ]);

  return (
    <div className="min-h-full bg-white dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <Link
            href="/"
            className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            ← Back to feed
          </Link>
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            Saved
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {items.length} {items.length === 1 ? "item" : "items"}, most recently saved first.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6">
        {items.length === 0 ? (
          <p className="py-16 text-center text-sm text-zinc-500 dark:text-zinc-400">
            Nothing saved yet. Use ☆ Save on any item in the feed.
          </p>
        ) : (
          items.map((item) => (
            <FeedItemCard
              key={item.id}
              item={item}
              isRead={interactions.read.has(item.id)}
              isSaved={interactions.saved.has(item.id)}
              signedIn
            />
          ))
        )}
      </main>
    </div>
  );
}

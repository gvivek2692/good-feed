import Link from "next/link";
import { notFound } from "next/navigation";

import { ItemActions } from "@/components/item-actions";
import { Markdown } from "@/components/markdown";
import { getSessionUserId } from "@/lib/auth/session";
import { getOrCreateDeepDive } from "@/lib/db/deep-dive";
import { getFeedItem } from "@/lib/db/feed";
import { EMPTY_INTERACTIONS, getItemInteractions } from "@/lib/db/interactions";

const SOURCE_LABELS: Record<string, string> = {
  ARXIV: "arXiv",
  HUGGINGFACE: "HuggingFace",
  HACKERNEWS: "Hacker News",
};

/** ~250wpm, the usual estimate for non-technical prose. */
function readingMinutes(text: string): number {
  return Math.max(1, Math.round(text.trim().split(/\s+/).length / 250));
}

/**
 * The deep-dive page.
 *
 * Generated on first visit and cached, per the spec's resolved decision 1 —
 * most items are never opened, so pre-generating would spend tokens on every
 * item to serve the few that get read. The first visitor waits; everyone after
 * reads from the database.
 */
export default async function ItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const item = await getFeedItem(id);

  if (!item) notFound();

  const [deepDive, userId] = await Promise.all([getOrCreateDeepDive(id), getSessionUserId()]);

  // This is where a reader most plausibly finishes an item, so the same
  // controls belong here rather than only in the feed.
  const interactions = userId ? await getItemInteractions(userId, [id]) : EMPTY_INTERACTIONS;

  return (
    <div className="min-h-full bg-white dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto max-w-2xl px-6 py-5">
          <Link
            href="/"
            className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            ← Back to feed
          </Link>
        </div>
      </header>

      <article className="mx-auto max-w-2xl px-6 py-10">
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {SOURCE_LABELS[item.sourceKind] ?? item.sourceKind}
          </span>
          {item.topics.map((topic) => (
            <span
              key={topic.slug}
              className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800"
            >
              {topic.label}
            </span>
          ))}
          {deepDive.ok ? <span>{readingMinutes(deepDive.value.content)} min read</span> : null}
        </div>

        <h1 className="text-3xl font-bold leading-tight tracking-tight text-zinc-900 dark:text-zinc-50">
          {item.headline ?? item.title}
        </h1>

        {item.whyItMatters ? (
          <p className="mt-4 text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
            {item.whyItMatters}
          </p>
        ) : null}

        <div className="mt-8 border-t border-zinc-200 pt-8 dark:border-zinc-800">
          {deepDive.ok ? (
            <Markdown content={deepDive.value.content} />
          ) : (
            /*
             * A failed generation says so rather than showing a blank page.
             * The summary and take above are still on screen, so the visit is
             * not wasted.
             */
            <p className="rounded-md bg-zinc-50 p-4 text-sm text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              The longer explanation could not be generated for this item
              {deepDive.error.kind === "generation-failed" ? " right now" : ""}. The summary above
              still applies, and the source is linked below.
            </p>
          )}
        </div>

        {item.claims.length > 0 ? (
          <section className="mt-10 border-t border-zinc-200 pt-6 dark:border-zinc-800">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Claims, and the source text behind them
            </h2>
            <ul className="space-y-3">
              {item.claims.map((claim) => (
                <li key={claim.id} className="text-sm text-zinc-600 dark:text-zinc-400">
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">{claim.text}</span>
                  <br />
                  <span className="italic">&ldquo;{claim.quotedFrom}&rdquo;</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="mt-10 border-t border-zinc-200 pt-6 dark:border-zinc-800">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <a
              href={item.canonicalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-emerald-700 hover:underline dark:text-emerald-500"
            >
              Read the original →
            </a>
            <div className="flex items-center gap-1">
              <ItemActions
                itemId={item.id}
                isRead={interactions.read.has(item.id)}
                isSaved={interactions.saved.has(item.id)}
                signedIn={userId !== null}
              />
            </div>
          </div>
          <p className="mt-4 text-xs text-zinc-400 dark:text-zinc-600">
            Original title: <span className="italic">{item.title}</span>
            {item.authors.length > 0 ? <> · {item.authors.slice(0, 4).join(", ")}</> : null}
          </p>
          <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-600">
            Written by a model from the source text above. Comparative claims are checked against
            quoted source text; unsupported ones are removed.
          </p>
        </footer>
      </article>
    </div>
  );
}

import Link from "next/link";

import { ItemActions } from "@/components/item-actions";
import { type FeedItem } from "@/lib/db/feed";

const SOURCE_LABELS: Record<string, string> = {
  ARXIV: "arXiv",
  HUGGINGFACE: "HuggingFace",
  HACKERNEWS: "Hacker News",
};

function relativeDay(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

/**
 * One feed item, in the order a reader actually consumes it:
 * headline → why it matters → summary → source.
 *
 * The headline is generated, not the paper's title, because paper titles are
 * written to be precise for reviewers rather than legible in a feed. The
 * original title stays visible as the label on the source link, so the item is
 * always identifiable and the substitution is never a disguise.
 *
 * `whyItMatters` sits directly under the headline as a subheading: it is the
 * reason to keep reading, and burying it under the summary made the reader do
 * the triage themselves. It is styled distinctly because it carries a different
 * warranty — the summary describes, the take judges.
 */
export function FeedItemCard({
  item,
  isRead = false,
  isSaved = false,
  signedIn = false,
}: {
  item: FeedItem;
  isRead?: boolean;
  isSaved?: boolean;
  /** Signed-out readers still get live controls; they prompt for sign-in. */
  signedIn?: boolean;
}): React.ReactElement {
  const headline = item.headline ?? item.title;
  const showOriginalTitle = item.headline !== null && item.headline !== item.title;

  return (
    <article
      className={`border-b border-zinc-200 py-8 transition-opacity dark:border-zinc-800 ${
        // Read items dim rather than disappear: the reader chose "done", not
        // "wrong", and a vanishing item makes the feed feel unstable.
        isRead ? "opacity-55" : ""
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          {SOURCE_LABELS[item.sourceKind] ?? item.sourceKind}
        </span>
        <span>{relativeDay(item.publishedAt)}</span>
        {item.topics.map((topic) => (
          <span
            key={topic.slug}
            className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
          >
            {topic.label}
          </span>
        ))}
      </div>

      {/*
        The headline links to the deep dive rather than the source. The spec's
        three exits are all still present, but the generated explanation is the
        one the headline promised — sending a reader who clicked a plain-language
        headline straight to a LaTeX abstract is a bait and switch.
      */}
      <h2 className="text-xl font-bold leading-snug tracking-tight text-zinc-900 dark:text-zinc-50">
        <Link href={`/item/${item.id}`} className="hover:underline">
          {headline}
        </Link>
      </h2>

      {item.whyItMatters ? (
        <p className="mt-2 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-400">
          {item.whyItMatters}
        </p>
      ) : null}

      {item.summary ? (
        <p className="mt-4 text-sm leading-relaxed text-zinc-500 dark:text-zinc-500">
          {item.summary}
        </p>
      ) : null}

      {item.claims.length > 0 ? (
        <ul className="mt-4 space-y-1.5 border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
          {item.claims.map((claim) => (
            <li key={claim.id} className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              <span className="font-medium">{claim.text}</span> —{" "}
              <a
                href={claim.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="italic underline decoration-dotted underline-offset-2"
              >
                &ldquo;{claim.quotedFrom}&rdquo;
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
        {/*
          The source link carries the original title rather than the word
          "Source". A reader needs the title to identify the item anyway, and it
          is the same destination — two elements saying the same thing in
          different words was one more than the card needed.
        */}
        <a
          href={item.canonicalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-zinc-500 hover:underline dark:text-zinc-400"
        >
          {showOriginalTitle ? (
            <>
              Source: <span className="italic">{item.title}</span>
            </>
          ) : (
            "Source"
          )}
        </a>

        {/*
          Ranking must always be explainable in numbers (spec). Kept in a
          details element so the feed stays readable while the evidence is one
          click away.
        */}
        {item.snapshot ? (
          <details className="text-xs text-zinc-500 dark:text-zinc-400">
            <summary className="cursor-pointer select-none hover:text-zinc-700 dark:hover:text-zinc-300">
              Why is this here? ({item.importanceScore?.toFixed(3)})
            </summary>
            <dl className="mt-2 space-y-1 rounded-md bg-zinc-50 p-3 font-mono text-[11px] dark:bg-zinc-900">
              <div>
                cluster: {item.snapshot.cluster} · sources: {item.snapshot.sourceCount} · recency
                &times;{item.snapshot.recencyMultiplier?.toFixed(2)}
              </div>
              <div>
                distribution: {item.snapshot.distributionSource} · rank in cluster:{" "}
                {item.snapshot.withinClusterPosition}
              </div>
              {Object.entries(item.snapshot.percentiles ?? {}).map(([name, value]) => (
                <div key={name}>
                  {name}: {item.snapshot?.raw?.[name]} (p{Math.round(value * 100)})
                </div>
              ))}
            </dl>
          </details>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          <ItemActions itemId={item.id} isRead={isRead} isSaved={isSaved} signedIn={signedIn} />
        </div>
      </div>
    </article>
  );
}

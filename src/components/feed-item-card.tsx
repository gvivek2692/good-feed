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
 * One feed item.
 *
 * The take is visually separated from the summary because they carry different
 * warranties: the summary describes the item, while `whyItMatters` is judgment.
 * Claims render as visible citations on the take — the spec requires every
 * comparative assertion to show the source text it rests on.
 */
export function FeedItemCard({ item }: { item: FeedItem }): React.ReactElement {
  return (
    <article className="border-b border-zinc-200 py-8 dark:border-zinc-800">
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

      <h2 className="mb-3 text-lg font-semibold leading-snug text-zinc-900 dark:text-zinc-50">
        <a
          href={item.canonicalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >
          {item.title}
        </a>
      </h2>

      {item.summary ? (
        <p className="mb-4 text-[15px] leading-relaxed text-zinc-700 dark:text-zinc-300">
          {item.summary}
        </p>
      ) : null}

      {item.whyItMatters ? (
        <div className="mb-4 border-l-2 border-emerald-500 pl-4">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-500">
            Why it matters
          </div>
          <p className="text-[15px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            {item.whyItMatters}
          </p>

          {item.claims.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {item.claims.map((claim) => (
                <li
                  key={claim.id}
                  className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400"
                >
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
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <a
          href={item.canonicalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-emerald-700 hover:underline dark:text-emerald-500"
        >
          Read the source →
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
      </div>
    </article>
  );
}

import Link from "next/link";

import { type FeedItem } from "@/lib/db/feed";

const SOURCE_LABELS: Record<string, string> = {
  ARXIV: "arXiv",
  HUGGINGFACE: "HuggingFace",
  HACKERNEWS: "Hacker News",
  GITHUB: "GitHub",
};

/**
 * One colour per source, so provenance is legible without reading.
 *
 * Deliberately restrained: a tinted label rather than a filled badge. Four
 * saturated chips per screen would compete with the headline, which is the
 * thing a reader is actually scanning for.
 */
const SOURCE_ACCENTS: Record<string, string> = {
  ARXIV: "text-rose-700 dark:text-rose-400",
  HUGGINGFACE: "text-amber-700 dark:text-amber-400",
  HACKERNEWS: "text-orange-700 dark:text-orange-400",
  GITHUB: "text-violet-700 dark:text-violet-400",
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
export function FeedItemCard({ item }: { item: FeedItem }): React.ReactElement {
  const headline = item.headline ?? item.title;
  const showOriginalTitle = item.headline !== null && item.headline !== item.title;

  return (
    <article className="border-b border-zinc-200/70 py-10 last:border-0 dark:border-zinc-800/70">
      {/*
        Source is colour-coded. Four sources rendered in identical grey made the
        one piece of provenance a reader scans for invisible at a glance.
      */}
      <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
        <span className={`font-semibold tracking-wide ${SOURCE_ACCENTS[item.sourceKind] ?? ""}`}>
          {SOURCE_LABELS[item.sourceKind] ?? item.sourceKind}
        </span>
        <span className="text-zinc-400 dark:text-zinc-600">·</span>
        <span className="text-zinc-500 dark:text-zinc-500">{relativeDay(item.publishedAt)}</span>
        {item.topics.map((topic) => (
          <span
            key={topic.slug}
            className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800/80 dark:text-zinc-400"
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
      <h2 className="prose-measure text-[1.375rem] font-semibold leading-[1.3] tracking-[-0.015em] text-zinc-900 dark:text-zinc-50">
        <Link
          href={`/item/${item.id}`}
          className="decoration-zinc-300 decoration-2 underline-offset-4 hover:underline dark:decoration-zinc-600"
        >
          {headline}
        </Link>
      </h2>

      {/*
        The take is set larger than the summary, not the same size. They carry
        different warranties — the take judges, the summary describes — and
        rendering them identically made the reader do that triage themselves.
      */}
      {item.whyItMatters ? (
        <p className="prose-measure mt-3 text-[1.0625rem] leading-[1.65] text-zinc-700 dark:text-zinc-300">
          {item.whyItMatters}
        </p>
      ) : null}

      {item.summary ? (
        <p className="prose-measure mt-4 text-sm leading-[1.7] text-zinc-500 dark:text-zinc-500">
          {item.summary}
        </p>
      ) : null}

      {item.claims.length > 0 ? (
        <ul className="prose-measure mt-5 space-y-2 border-l-2 border-emerald-500/30 pl-4 dark:border-emerald-500/25">
          {item.claims.map((claim) => (
            <li
              key={claim.id}
              className="text-[13px] leading-[1.6] text-zinc-500 dark:text-zinc-400"
            >
              <span className="font-medium text-zinc-700 dark:text-zinc-300">{claim.text}</span>{" "}
              <a
                href={claim.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="italic decoration-dotted underline-offset-2 hover:underline"
              >
                &ldquo;{claim.quotedFrom}&rdquo;
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="prose-measure mt-5 flex flex-wrap items-center gap-4 text-xs">
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
          className="text-zinc-400 transition-colors hover:text-zinc-700 dark:text-zinc-600 dark:hover:text-zinc-300"
        >
          {showOriginalTitle ? (
            <>
              Source: <span className="italic">{item.title}</span>
            </>
          ) : (
            "Source"
          )}
        </a>
      </div>
    </article>
  );
}

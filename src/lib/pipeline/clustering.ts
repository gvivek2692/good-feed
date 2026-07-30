import { type NormalizedItem } from "@/lib/sources/types";

/**
 * A group of items covering the same underlying development.
 *
 * Clustering happens **only within the research cluster** — arXiv and
 * HuggingFace Papers, joined on version-stripped arXiv id. Hacker News items
 * never merge with papers: measured zero joins against both paper corpora via
 * three independent strategies. See docs/adr/001.
 */
export interface Cluster {
  /** Stable id derived from the join key, so re-runs produce the same clusters. */
  id: string;
  items: NormalizedItem[];
  /** Distinct source kinds represented. This count is a ranking signal. */
  sourceCount: number;
  /** Which item represents the cluster in the feed. */
  primary: NormalizedItem;
}

/**
 * Source preference when picking a cluster's representative.
 *
 * HuggingFace wins over arXiv for the same paper: it carries the community
 * signals (upvotes, stars) that ranking needs, and its metadata is curated.
 * The arXiv entry contributes the abstract and the coverage count.
 */
const SOURCE_PRIORITY: Record<NormalizedItem["kind"], number> = {
  HUGGINGFACE: 0,
  ARXIV: 1,
  // Above HN so that when a trending repo and an HN story about it merge, the
  // repo is the representative: the repo is the development, the thread is
  // coverage of it. HN's discussion signals survive on the merged cluster.
  GITHUB: 2,
  HACKERNEWS: 3,
};

function pickPrimary(items: NormalizedItem[]): NormalizedItem {
  return [...items].sort((a, b) => {
    const bySource = SOURCE_PRIORITY[a.kind] - SOURCE_PRIORITY[b.kind];
    if (bySource !== 0) return bySource;
    // Deterministic tiebreak so clustering is reproducible across runs.
    return a.externalId.localeCompare(b.externalId);
  })[0];
}

/**
 * `owner/name` from a GitHub URL, lowercased.
 *
 * Handles the forms an HN submission actually uses: bare repo, `/blob/...`,
 * `/tree/...`, a `.git` suffix, and trailing slashes. Returns null for
 * non-repo GitHub URLs such as `/features` or a gist.
 */
function repoSlug(url: string): string | null {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)/i.exec(url);
  if (!match) return null;

  const owner = match[1];
  const name = match[2].replace(/\.git$/i, "");
  // Reserved paths that look like an owner but are not.
  if (["features", "about", "pricing", "orgs", "sponsors"].includes(owner.toLowerCase())) {
    return null;
  }
  return `${owner}/${name}`.toLowerCase();
}

/**
 * The key two items must share to be the same development.
 *
 * Papers join on arXiv id. Everything else keys on itself, which means it forms
 * a cluster of one — the correct outcome for HN, whose items are genuinely
 * distinct developments rather than coverage of a paper.
 */
function joinKey(item: NormalizedItem): string {
  if (item.kind === "GITHUB") {
    // Keyed on owner/name so an HN story linking the same repo merges into it.
    return `repo:${item.title.toLowerCase()}`;
  }

  if (item.kind === "HACKERNEWS") {
    // An HN story pointing at a repo is coverage of that repo, so it shares the
    // repo's key. Measured 2026-07-30: 0 of 21 trending repos also appeared on
    // HN, so this fires rarely — but the cost is one regex and the alternative
    // is the same repo twice in one feed.
    const repo = repoSlug(item.canonicalUrl);
    if (repo) return `repo:${repo}`;

    // Otherwise deliberately self-keyed, even when the story links to arXiv:
    // such a story is a discussion *about* the paper, and the discussion
    // cluster is ranked on its own signals. Merging would hide one behind the
    // other.
    return `hn:${item.externalId}`;
  }

  return item.arxivId ? `arxiv:${item.arxivId}` : `${item.kind.toLowerCase()}:${item.externalId}`;
}

/**
 * Groups items into clusters. Pure and order-independent: the same input set
 * yields the same clusters regardless of the order it arrives in.
 */
export function clusterItems(items: NormalizedItem[]): Cluster[] {
  const groups = new Map<string, NormalizedItem[]>();

  for (const item of items) {
    const key = joinKey(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  return [...groups.entries()]
    .map(([id, groupItems]) => ({
      id,
      items: groupItems,
      sourceCount: new Set(groupItems.map((i) => i.kind)).size,
      primary: pickPrimary(groupItems),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Collapses repeated fetches of the same record within one source.
 *
 * Distinct from clustering: this removes duplicates, whereas clustering groups
 * genuinely different records covering one development. Runs first, so a paper
 * fetched twice does not inflate its own cluster's `sourceCount`.
 */
export function dedupeWithinSource(items: NormalizedItem[]): NormalizedItem[] {
  const seen = new Map<string, NormalizedItem>();

  for (const item of items) {
    const key = `${item.kind}:${item.externalId}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, item);
      continue;
    }
    // Keep the fresher snapshot — signals like upvotes and points grow over time.
    if (item.publishedAt >= existing.publishedAt) {
      seen.set(key, item);
    }
  }

  return [...seen.values()];
}

import { type Cluster } from "@/lib/pipeline/clustering";

/**
 * The two clusters established by ADR 001. They share no items and their
 * signals are not commensurable, so each is normalized against its own
 * distribution and floored on its own raw units.
 */
/**
 * The cluster kinds, as a value so the ranking code can iterate them. Adding a
 * kind here is the single edit needed — every per-cluster structure below is
 * built from this list rather than spelling the kinds out again.
 */
export const CLUSTER_KINDS = ["research", "discussion", "code"] as const;

export type ClusterKind = (typeof CLUSTER_KINDS)[number];

/** Builds a per-cluster record, so no call site can forget a kind. */
function byCluster<T>(make: () => T): Record<ClusterKind, T> {
  return Object.fromEntries(CLUSTER_KINDS.map((kind) => [kind, make()])) as Record<ClusterKind, T>;
}

/** Whether the distribution was derived from fixtures or from real history. */
export type DistributionSource = "seeded" | "historical";

export interface SignalSnapshot {
  cluster: ClusterKind;
  /** Raw signal values, exactly as the adapters recorded them. */
  raw: Record<string, number>;
  /** Percentile each raw value mapped to, computed per signal. */
  percentiles: Record<string, number>;
  distributionSource: DistributionSource;
  /** Number of distinct sources covering the cluster. */
  sourceCount: number;
  recencyMultiplier: number;
  /** 1-based rank within this item's own cluster. Assigned by rankClusters. */
  withinClusterPosition: number;
}

export interface ScoredCluster {
  cluster: Cluster;
  score: number;
  snapshot: SignalSnapshot;
  included: boolean;
  exclusionReason?: "below-absolute-floor";
}

export type Distributions = {
  source: DistributionSource;
  /** Sorted ascending, per cluster per signal. */
  bySignal: Record<ClusterKind, Record<string, number[]>>;
  /**
   * Median item age per cluster, in days, at the time the distributions were
   * built. Recency is measured against this rather than against absolute age.
   */
  medianAgeDays: Record<ClusterKind, number>;
  /** The instant ages were measured from, so scoring stays a pure function. */
  builtAt: Date;
};

/**
 * Signals that contribute to the score, and their weights within a cluster.
 *
 * Weights are relative within a cluster only — they are never compared across
 * clusters, since percentile normalization is what makes the two orderings
 * commensurable.
 *
 * `hfComments` is deliberately absent. Measured over the 245-paper fixture:
 * p50=2, p90=3, max=11, across roughly eleven distinct values. At that
 * granularity percentile rank is mostly ties and carries almost no ordering
 * information, so including it would add noise dressed as signal.
 */
const SIGNAL_WEIGHTS: Record<ClusterKind, Record<string, number>> = {
  research: {
    upvotes: 0.6,
    githubStars: 0.25,
    categoryCount: 0.15,
  },
  discussion: {
    points: 0.4,
    pointsPerHour: 0.3,
    comments: 0.15,
    commentsPerHour: 0.15,
  },
  /**
   * `starsToday` carries most of the weight because it is the only signal here
   * that describes *now*: GitHub computes it, and it is what makes a repo
   * trending rather than merely large. Measured on the daily page (n=14):
   * min=5, p50=180, max=916, with **14 distinct values out of 14** — no ties,
   * so percentile rank is fully informative. Contrast `hfComments`, excluded
   * from the research cluster for the opposite reason.
   *
   * `stars` is a small term for corroboration only. On its own it ranks by fame
   * (p50=26k, max=236k) and would put every long-established repo on top, which
   * is the failure this source exists to avoid.
   *
   * `forks` is deliberately absent: measured p50=3253 against stars p50=26219,
   * it tracks total stars closely enough to add correlation rather than signal.
   */
  code: {
    starsToday: 0.8,
    stars: 0.2,
  },
};

/**
 * Raw minimums an item must clear to reach the feed, per ADR 002.
 *
 * These make "nothing important happened" representable: percentiles alone
 * would promote each source's best item on a dead week, contradicting the
 * spec's rule that a quiet week yields a short feed.
 *
 * Research floors sit near the fixture's p25 for upvotes (p50=15, p75=34).
 * The discussion floor is the weakest-justified number here: Algolia's search
 * only returns already-popular stories, so the fixture's minimum is 10 points
 * and it cannot show what a weak HN item looks like. 25 is a deliberate choice
 * pending real ingest history, not a measured one.
 */
export const ABSOLUTE_FLOORS = {
  research: { upvotes: 8 },
  discussion: { points: 25 },
  /**
   * Measured on the daily trending page (n=14): min=5, p25=68, p50=180.
   *
   * 50 sits between the observed minimum and p25 — it excludes the tail that is
   * on the page for reasons other than momentum (`dotnet/aspnetcore` at +5,
   * `WhiskeySockets/Baileys` at +12) without cutting into the body of the
   * distribution.
   *
   * Assumes the **daily** window. The weekly page is a different scale entirely
   * (min=996, p50=2892), so `fetchTrendingRepos` must not be switched to weekly
   * without revisiting this number.
   */
  code: { starsToday: 50 },
} as const;

/** Coverage by a second source clears the research floor on its own (ADR 001). */
const COVERAGE_BONUS = 0.15;

/** Half-life in days for the recency multiplier. */
const RECENCY_HALF_LIFE_DAYS = 7;

/**
 * Bounds on the recency multiplier. Age dampens or lifts a score but can never
 * zero it or dominate it — the spec's "multiplier, never a primary term".
 */
const MIN_RECENCY_MULTIPLIER = 0.6;
const MAX_RECENCY_MULTIPLIER = 1.4;

export function clusterOf(cluster: Cluster): ClusterKind {
  // Checked before HN so a repo that merged with its own HN thread is ranked as
  // code: the repo is the development, the thread is coverage of it.
  if (cluster.items.some((item) => item.kind === "GITHUB")) return "code";
  return cluster.items.some((item) => item.kind === "HACKERNEWS") ? "discussion" : "research";
}

/**
 * Fraction of the distribution at or below `value`.
 *
 * Clamped to [0, 1]: a value above everything observed is 1, not more.
 */
export function percentileOf(value: number, sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;

  let below = 0;
  for (const entry of sorted) {
    if (entry <= value) below += 1;
    else break;
  }

  return Math.min(1, Math.max(0, below / sorted.length));
}

function numericSignals(cluster: Cluster): Record<string, number> {
  const weights = SIGNAL_WEIGHTS[clusterOf(cluster)];
  const raw: Record<string, number> = {};

  for (const item of cluster.items) {
    for (const name of Object.keys(weights)) {
      const value = item.signals[name];
      if (typeof value !== "number" || Number.isNaN(value)) continue;
      // A cluster can hold the same paper from two sources; keep the strongest
      // snapshot, matching how HuggingFace recurrence is deduped upstream.
      raw[name] = Math.max(raw[name] ?? Number.NEGATIVE_INFINITY, value);
    }
  }

  return raw;
}

/**
 * Builds trailing per-signal distributions from a corpus.
 *
 * Per ADR 002 these are per signal rather than per item: points and comment
 * velocity have different shapes, so one combined distribution would let the
 * wider-spread signal dominate.
 */
export function buildDistributions(
  clusters: readonly Cluster[],
  source: DistributionSource = "seeded",
  builtAt: Date = new Date(),
): Distributions {
  const bySignal = byCluster<Record<string, number[]>>(() => ({}));
  const ages = byCluster<number[]>(() => []);

  for (const cluster of clusters) {
    const kind = clusterOf(cluster);
    for (const [name, value] of Object.entries(numericSignals(cluster))) {
      (bySignal[kind][name] ??= []).push(value);
    }
    ages[kind].push(
      Math.max(0, (builtAt.getTime() - cluster.primary.publishedAt.getTime()) / 86_400_000),
    );
  }

  const medianAgeDays = byCluster<number>(() => 0);

  for (const kind of CLUSTER_KINDS) {
    for (const values of Object.values(bySignal[kind])) {
      values.sort((a, b) => a - b);
    }
    const sortedAges = ages[kind].sort((a, b) => a - b);
    medianAgeDays[kind] =
      sortedAges.length > 0 ? sortedAges[Math.floor((sortedAges.length - 1) / 2)] : 0;
  }

  return { source, bySignal, medianAgeDays, builtAt };
}

/**
 * Exponential decay on age, relative to the cluster's own median age.
 *
 * Measured on the fixture corpus, absolute decay made recency the primary term
 * across clusters — precisely what the spec forbids. HN items had a median age
 * of 0.9 days against papers' 3.6, because Algolia returns what is hot right
 * now while arXiv returns a 14-day window. That is a property of the APIs, not
 * evidence that papers matter less, and it penalised every paper by 2.1x as a
 * group: an HN story with the corpus maximum 1023 points ranked below three
 * papers purely on age.
 *
 * Centring on the cluster median makes this "fresh for its kind", which is the
 * only comparison that means anything across two sources with different
 * publication rhythms. Within a cluster the ordering is unchanged.
 */
function recencyMultiplier(cluster: Cluster, now: Date, medianAgeDays: number): number {
  const publishedAt = cluster.primary.publishedAt.getTime();
  const ageDays = Math.max(0, (now.getTime() - publishedAt) / 86_400_000);
  const relative = ageDays - medianAgeDays;
  const decayed = Math.pow(0.5, relative / RECENCY_HALF_LIFE_DAYS);

  return Math.min(MAX_RECENCY_MULTIPLIER, Math.max(MIN_RECENCY_MULTIPLIER, decayed));
}

/**
 * Scores one cluster from its stored signals. No LLM involvement, by design —
 * the spec keeps phase 1 ordering entirely signal-driven.
 */
export function scoreCluster(
  cluster: Cluster,
  distributions: Distributions,
  now: Date,
): ScoredCluster {
  const kind = clusterOf(cluster);
  const weights = SIGNAL_WEIGHTS[kind];
  const raw = numericSignals(cluster);

  const percentiles: Record<string, number> = {};
  let weighted = 0;
  let totalWeight = 0;

  for (const [name, weight] of Object.entries(weights)) {
    const value = raw[name];
    // An absent signal is absent, not zero — scoring it as a zero percentile
    // would punish a paper for having no GitHub repo rather than leaving the
    // signal out of its average.
    if (value === undefined) continue;

    const percentile = percentileOf(value, distributions.bySignal[kind][name] ?? []);
    percentiles[name] = percentile;
    weighted += percentile * weight;
    totalWeight += weight;
  }

  const base = totalWeight > 0 ? weighted / totalWeight : 0;

  // Cross-source coverage is the strongest research signal (ADR 001) and is
  // structurally unavailable to Hacker News, so it is added inside the research
  // cluster rather than in a shared formula where its absence would read as a
  // penalty against every HN item.
  const coverage = kind === "research" && cluster.sourceCount > 1 ? COVERAGE_BONUS : 0;
  const multiplier = recencyMultiplier(cluster, now, distributions.medianAgeDays[kind]);

  return {
    cluster,
    score: (base + coverage) * multiplier,
    snapshot: {
      cluster: kind,
      raw,
      percentiles,
      distributionSource: distributions.source,
      sourceCount: cluster.sourceCount,
      recencyMultiplier: multiplier,
      withinClusterPosition: 0,
    },
    included: false,
  };
}

/**
 * Whether an item clears its cluster's raw minimum.
 *
 * Two-source coverage clears the research floor on its own: a paper both arXiv
 * and HuggingFace carry has passed a human curation step that upvote count
 * alone does not capture.
 */
function clearsFloor(scored: ScoredCluster): boolean {
  const { snapshot } = scored;

  if (snapshot.cluster === "research") {
    if (snapshot.sourceCount > 1) return true;
    return (snapshot.raw.upvotes ?? 0) >= ABSOLUTE_FLOORS.research.upvotes;
  }

  if (snapshot.cluster === "code") {
    return (snapshot.raw.starsToday ?? 0) >= ABSOLUTE_FLOORS.code.starsToday;
  }

  // Switched on explicitly rather than left as a fallthrough: a new cluster
  // reaching this line would be floored on `points`, a signal it does not have,
  // and would be silently rejected in full.
  return (snapshot.raw.points ?? 0) >= ABSOLUTE_FLOORS.discussion.points;
}

/**
 * Scores and orders a corpus, marking which items reach the feed.
 *
 * Below-floor items are ranked and returned rather than dropped, so a run log
 * can show what was excluded and why instead of silently shrinking.
 */
export function rankClusters(
  clusters: readonly Cluster[],
  distributions: Distributions,
  now: Date,
): ScoredCluster[] {
  const scored = clusters
    .map((cluster) => scoreCluster(cluster, distributions, now))
    .sort((a, b) => b.score - a.score || a.cluster.id.localeCompare(b.cluster.id));

  const positions = byCluster<number>(() => 0);

  for (const entry of scored) {
    positions[entry.snapshot.cluster] += 1;
    entry.snapshot.withinClusterPosition = positions[entry.snapshot.cluster];

    if (clearsFloor(entry)) {
      entry.included = true;
    } else {
      entry.included = false;
      entry.exclusionReason = "below-absolute-floor";
    }
  }

  return scored;
}

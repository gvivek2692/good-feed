/** @vitest-environment node */
import { describe, expect, it } from "vitest";

import { type Cluster } from "@/lib/pipeline/clustering";
import {
  ABSOLUTE_FLOORS,
  buildDistributions,
  clusterOf,
  percentileOf,
  rankClusters,
  scoreCluster,
} from "@/lib/ranking/score";
import { type NormalizedItem } from "@/lib/sources/types";

const NOW = new Date("2026-07-27T12:00:00Z");

function item(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    externalId: "2607.1",
    kind: "ARXIV",
    title: "A paper",
    authors: ["A"],
    publishedAt: new Date("2026-07-26T12:00:00Z"),
    canonicalUrl: "https://arxiv.org/abs/2607.1",
    sourceUrl: "https://arxiv.org/abs/2607.1",
    text: "Abstract.",
    arxivId: "2607.1",
    signals: {},
    raw: {},
    ...overrides,
  };
}

function hf(upvotes: number, extra: Record<string, number | string | null> = {}): NormalizedItem {
  return item({
    kind: "HUGGINGFACE",
    externalId: `hf-${upvotes}`,
    signals: { upvotes, comments: 2, githubStars: null, ...extra },
  });
}

/**
 * Velocity is deliberately not a fixed ratio of points. In the real fixture the
 * two are only loosely related (points p50=22 while pointsPerHour p50=0.80), and
 * a helper that derived one from the other would make every signal perfectly
 * correlated — hiding exactly the per-signal bugs these tests exist to catch.
 */
function hn(points: number, extra: Record<string, number | string | null> = {}): NormalizedItem {
  const ageHours = 6 + (points % 7) * 12;
  return item({
    kind: "HACKERNEWS",
    externalId: `hn-${points}`,
    arxivId: null,
    signals: {
      points,
      comments: Math.round(points / 2),
      pointsPerHour: Number((points / ageHours).toFixed(4)),
      commentsPerHour: Number((points / 2 / ageHours).toFixed(4)),
      ...extra,
    },
  });
}

function cluster(items: NormalizedItem[]): Cluster {
  return {
    id: items[0].externalId,
    items,
    sourceCount: new Set(items.map((i) => i.kind)).size,
    primary: items[0],
  };
}

/** A spread of HF and HN items to build non-degenerate distributions from. */
function baselineClusters(): Cluster[] {
  const hfItems = [2, 5, 10, 15, 25, 40, 60, 90, 150, 250].map((u) => cluster([hf(u)]));
  const hnItems = [5, 12, 22, 40, 70, 110, 160, 250, 500, 900].map((p) => cluster([hn(p)]));
  return [...hfItems, ...hnItems];
}

describe("clusterOf", () => {
  it("puts papers in the research cluster", () => {
    expect(clusterOf(cluster([hf(10)]))).toBe("research");
    expect(clusterOf(cluster([item()]))).toBe("research");
  });

  it("puts Hacker News in the discussion cluster", () => {
    expect(clusterOf(cluster([hn(100)]))).toBe("discussion");
  });
});

describe("percentileOf", () => {
  const dist = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  /**
   * Inclusive: "what fraction of the trailing window does this match or beat".
   * The minimum still beats itself, so it lands at 1/n rather than 0.
   */
  it("puts the minimum near the bottom and the maximum at the top", () => {
    expect(percentileOf(1, dist)).toBeCloseTo(1 / dist.length, 5);
    expect(percentileOf(10, dist)).toBe(1);
  });

  it("puts the median near the middle", () => {
    expect(percentileOf(5, dist)).toBeGreaterThan(0.35);
    expect(percentileOf(5, dist)).toBeLessThan(0.65);
  });

  it("clamps a value above the observed maximum rather than exceeding 1", () => {
    expect(percentileOf(9999, dist)).toBe(1);
  });

  it("returns 0 for an empty distribution rather than dividing by zero", () => {
    expect(percentileOf(5, [])).toBe(0);
  });
});

describe("scoreCluster", () => {
  const distributions = buildDistributions(baselineClusters());

  it("is a pure function — same input, same output", () => {
    const target = cluster([hf(60)]);
    const a = scoreCluster(target, distributions, NOW);
    const b = scoreCluster(target, distributions, NOW);

    expect(a.score).toBe(b.score);
    expect(a.snapshot).toEqual(b.snapshot);
  });

  it("scores a higher-upvoted paper above a lower one", () => {
    const high = scoreCluster(cluster([hf(250)]), distributions, NOW);
    const low = scoreCluster(cluster([hf(5)]), distributions, NOW);

    expect(high.score).toBeGreaterThan(low.score);
  });

  /**
   * Acceptance criterion: two-source coverage is the strongest research signal
   * available, per ADR 001.
   */
  it("ranks a two-source paper above an otherwise identical one-source paper", () => {
    const covered = cluster([hf(40), item({ kind: "ARXIV", signals: {} })]);
    const single = cluster([hf(40)]);

    expect(scoreCluster(covered, distributions, NOW).score).toBeGreaterThan(
      scoreCluster(single, distributions, NOW).score,
    );
  });

  /**
   * Acceptance criterion: HN cannot carry a cross-source coverage signal at all
   * (ADR 001 measured zero joins). If coverage were scored inside a shared
   * formula, every HN item would be structurally penalised.
   */
  it("does not bury a strong HN item beneath a weak paper", () => {
    const strongHn = scoreCluster(cluster([hn(900)]), distributions, NOW);
    const weakPaper = scoreCluster(cluster([hf(2)]), distributions, NOW);

    expect(strongHn.score).toBeGreaterThan(weakPaper.score);
  });

  it("records raw values, percentiles, provenance, cluster, and position in the snapshot", () => {
    const { snapshot } = scoreCluster(cluster([hf(60)]), distributions, NOW);

    expect(snapshot.cluster).toBe("research");
    expect(snapshot.raw.upvotes).toBe(60);
    expect(snapshot.percentiles.upvotes).toBeGreaterThan(0);
    expect(snapshot.distributionSource).toBe("seeded");
    expect(snapshot.sourceCount).toBe(1);
  });

  it("labels a historical distribution as historical, not seeded", () => {
    const historical = buildDistributions(baselineClusters(), "historical");
    const { snapshot } = scoreCluster(cluster([hf(60)]), historical, NOW);

    expect(snapshot.distributionSource).toBe("historical");
  });

  /** Percentiles must be per signal — points and comment velocity differ in shape. */
  it("computes a separate percentile for each signal", () => {
    const { snapshot } = scoreCluster(cluster([hn(160)]), distributions, NOW);

    expect(Object.keys(snapshot.percentiles)).toContain("points");
    expect(Object.keys(snapshot.percentiles)).toContain("pointsPerHour");
    expect(snapshot.percentiles.points).not.toBe(snapshot.percentiles.commentsPerHour);
  });

  /** Recency is a multiplier, never a primary term. */
  it("prefers the newer of two otherwise identical items", () => {
    const fresh = cluster([hf(40)]);
    const stale = cluster([hf(40, {})]);
    stale.items[0] = { ...stale.items[0], publishedAt: new Date("2026-07-01T12:00:00Z") };
    stale.primary = stale.items[0];

    expect(scoreCluster(fresh, distributions, NOW).score).toBeGreaterThan(
      scoreCluster(stale, distributions, NOW).score,
    );
  });

  it("does not let recency alone outrank a much stronger older item", () => {
    const freshWeak = cluster([hf(2)]);
    const staleStrong = cluster([hf(250)]);
    staleStrong.items[0] = {
      ...staleStrong.items[0],
      publishedAt: new Date("2026-07-14T12:00:00Z"),
    };
    staleStrong.primary = staleStrong.items[0];

    expect(scoreCluster(staleStrong, distributions, NOW).score).toBeGreaterThan(
      scoreCluster(freshWeak, distributions, NOW).score,
    );
  });

  /**
   * Regression: measured on the full fixture corpus, absolute recency decay
   * made age the primary cross-cluster term. HN's median age is 0.9 days
   * against papers' 3.6 — an artifact of Algolia returning what is hot now
   * while arXiv returns a 14-day window — which penalised every paper by 2.1x
   * and put 18 of the top 25 in one cluster. Recency is measured against the
   * cluster's own median so it cannot encode that difference.
   */
  it("does not penalise a cluster for its source's slower publication rhythm", () => {
    const fresh = [1, 2, 3].map((i) =>
      cluster([hn(100, {})].map((it) => ({ ...it, externalId: `hn-fresh-${i}` }))),
    );
    const old = [1, 2, 3].map((i) =>
      cluster([
        { ...hf(100), externalId: `hf-old-${i}`, publishedAt: new Date("2026-07-20T12:00:00Z") },
      ]),
    );

    const distributions = buildDistributions([...fresh, ...old], "seeded", NOW);

    // Each cluster's items sit at their own median age, so neither is damped.
    const hnMultiplier = scoreCluster(fresh[0], distributions, NOW).snapshot.recencyMultiplier;
    const hfMultiplier = scoreCluster(old[0], distributions, NOW).snapshot.recencyMultiplier;

    expect(hnMultiplier).toBeCloseTo(hfMultiplier, 5);
  });

  it("keeps the recency multiplier bounded so it can never dominate the score", () => {
    const ancient = cluster([{ ...hf(40), publishedAt: new Date("2020-01-01T00:00:00Z") }]);
    const { snapshot } = scoreCluster(ancient, distributions, NOW);

    expect(snapshot.recencyMultiplier).toBeGreaterThanOrEqual(0.6);
    expect(snapshot.recencyMultiplier).toBeLessThanOrEqual(1.4);
  });

  it("treats a missing signal as absent rather than as zero-percentile", () => {
    const noStars = scoreCluster(cluster([hf(40)]), distributions, NOW);
    expect(noStars.snapshot.raw.githubStars).toBeUndefined();
  });
});

describe("rankClusters", () => {
  const distributions = buildDistributions(baselineClusters());

  it("orders by score, descending, and is stable across runs", () => {
    const input = [cluster([hf(5)]), cluster([hf(250)]), cluster([hf(40)])];
    const first = rankClusters(input, distributions, NOW).map((r) => r.cluster.id);
    const second = rankClusters(input, distributions, NOW).map((r) => r.cluster.id);

    expect(first).toEqual(second);
    expect(first[0]).toBe("hf-250");
  });

  it("interleaves both clusters rather than emitting one and then the other", () => {
    const input = [cluster([hf(250)]), cluster([hn(900)]), cluster([hf(150)]), cluster([hn(500)])];
    const kinds = rankClusters(input, distributions, NOW).map((r) => r.snapshot.cluster);

    expect(new Set(kinds).size).toBe(2);
  });

  it("records within-cluster position in each snapshot", () => {
    const input = [cluster([hf(250)]), cluster([hf(40)]), cluster([hn(900)])];
    const ranked = rankClusters(input, distributions, NOW);
    const research = ranked.filter((r) => r.snapshot.cluster === "research");

    expect(research.map((r) => r.snapshot.withinClusterPosition)).toEqual([1, 2]);
  });

  /**
   * The anti-padding guard, and the reason the absolute floor exists alongside
   * percentiles. A corpus of uniformly weak items must yield an empty feed —
   * percentile ranking alone would promote its own 99th percentile regardless.
   */
  it("yields an empty feed when nothing clears the absolute floor", () => {
    const weak = [cluster([hf(1)]), cluster([hf(2)]), cluster([hn(1)]), cluster([hn(2)])];
    const included = rankClusters(weak, distributions, NOW).filter((r) => r.included);

    expect(included).toHaveLength(0);
  });

  it("still ranks below-floor items rather than discarding them, so runs stay inspectable", () => {
    const weak = [cluster([hf(1)]), cluster([hf(2)])];
    const ranked = rankClusters(weak, distributions, NOW);

    expect(ranked).toHaveLength(2);
    expect(ranked.every((r) => !r.included)).toBe(true);
    expect(ranked[0].exclusionReason).toBe("below-absolute-floor");
  });

  it("includes an item that clears the floor in a weak corpus", () => {
    const mixed = [cluster([hf(1)]), cluster([hf(2)]), cluster([hf(120)])];
    const included = rankClusters(mixed, distributions, NOW).filter((r) => r.included);

    expect(included).toHaveLength(1);
    expect(included[0].cluster.id).toBe("hf-120");
  });

  it("applies the floor per cluster, since the units are not comparable", () => {
    expect(ABSOLUTE_FLOORS.research.upvotes).toBeGreaterThan(0);
    expect(ABSOLUTE_FLOORS.discussion.points).toBeGreaterThan(0);
  });

  it("lets two-source coverage carry a paper over the floor on its own", () => {
    const belowAlone = cluster([hf(ABSOLUTE_FLOORS.research.upvotes - 1)]);
    const covered = cluster([
      hf(ABSOLUTE_FLOORS.research.upvotes - 1),
      item({ kind: "ARXIV", signals: {} }),
    ]);

    expect(rankClusters([belowAlone], distributions, NOW)[0].included).toBe(false);
    expect(rankClusters([covered], distributions, NOW)[0].included).toBe(true);
  });

  it("produces a stable asserted ordering over a fixed mixed corpus", () => {
    const input = [
      cluster([hf(15)]),
      cluster([hn(900)]),
      cluster([hf(250), item({ kind: "ARXIV", signals: {} })]),
      cluster([hn(22)]),
      cluster([hf(90)]),
    ];

    expect(rankClusters(input, distributions, NOW).map((r) => r.cluster.id)).toEqual([
      "hf-250",
      "hn-900",
      "hf-90",
      "hf-15",
      "hn-22",
    ]);
  });
});

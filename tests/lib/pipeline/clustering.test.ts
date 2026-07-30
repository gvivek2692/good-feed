/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { clusterItems, dedupeWithinSource } from "@/lib/pipeline/clustering";
import { parseAtomFeed } from "@/lib/sources/arxiv";
import { parseSearchResponse } from "@/lib/sources/hackernews";
import { parseDailyPapers } from "@/lib/sources/huggingface";
import { type NormalizedItem } from "@/lib/sources/types";

function loadCorpus(): NormalizedItem[] {
  const arxiv = parseAtomFeed(
    readFileSync(join(process.cwd(), "tests/fixtures/arxiv-recent.xml"), "utf-8"),
  );
  const hf = parseDailyPapers(
    JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/hf-daily-papers.json"), "utf-8")),
  );
  const hn = parseSearchResponse(
    JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/hn-recent.json"), "utf-8")),
  );
  if (!arxiv.ok || !hf.ok || !hn.ok) throw new Error("fixtures failed to parse");
  return [...arxiv.value, ...hf.value, ...hn.value];
}

/** Minimal item builder for cases the fixtures do not contain. */
function item(overrides: Partial<NormalizedItem> & Pick<NormalizedItem, "kind">): NormalizedItem {
  return {
    externalId: "x1",
    title: "A paper",
    authors: [],
    publishedAt: new Date("2026-07-20T00:00:00Z"),
    canonicalUrl: "https://example.com",
    sourceUrl: "https://example.com",
    text: null,
    arxivId: null,
    signals: {},
    raw: {},
    ...overrides,
  };
}

describe("clusterItems", () => {
  it("merges an arXiv paper and its HuggingFace entry into one cluster", () => {
    const clusters = clusterItems([
      item({ kind: "ARXIV", externalId: "2607.22534v1", arxivId: "2607.22534" }),
      item({ kind: "HUGGINGFACE", externalId: "2607.22534", arxivId: "2607.22534" }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].items).toHaveLength(2);
    expect(clusters[0].sourceCount).toBe(2);
  });

  it("joins across version suffixes — arXiv carries them, HuggingFace does not", () => {
    // Measured in the fixtures: 391/391 arXiv ids have a vN suffix, 0/245 HF ids do.
    // Without version stripping the join rate would be zero.
    const clusters = clusterItems([
      item({ kind: "ARXIV", externalId: "2607.22534v2", arxivId: "2607.22534" }),
      item({ kind: "HUGGINGFACE", externalId: "2607.22534", arxivId: "2607.22534" }),
    ]);

    expect(clusters).toHaveLength(1);
  });

  it("keeps distinct papers separate even with identical authors", () => {
    const clusters = clusterItems([
      item({ kind: "ARXIV", externalId: "2607.00001v1", arxivId: "2607.00001", authors: ["Ada"] }),
      item({ kind: "ARXIV", externalId: "2607.00002v1", arxivId: "2607.00002", authors: ["Ada"] }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it("never merges a Hacker News item into a research cluster", () => {
    // Even when an HN story links directly to the paper: it is discussion
    // *about* the work, ranked on its own signals. See docs/adr/001.
    const clusters = clusterItems([
      item({ kind: "ARXIV", externalId: "2607.22534v1", arxivId: "2607.22534" }),
      item({ kind: "HACKERNEWS", externalId: "44112233", arxivId: "2607.22534" }),
    ]);

    expect(clusters).toHaveLength(2);
    for (const cluster of clusters) {
      const kinds = new Set(cluster.items.map((i) => i.kind));
      expect(kinds.has("HACKERNEWS") && kinds.size > 1).toBe(false);
    }
  });

  it("prefers the HuggingFace entry as primary — it carries the community signals", () => {
    const clusters = clusterItems([
      item({ kind: "ARXIV", externalId: "2607.22534v1", arxivId: "2607.22534" }),
      item({
        kind: "HUGGINGFACE",
        externalId: "2607.22534",
        arxivId: "2607.22534",
        signals: { upvotes: 197 },
      }),
    ]);

    expect(clusters[0].primary.kind).toBe("HUGGINGFACE");
    expect(clusters[0].primary.signals.upvotes).toBe(197);
  });

  it("is order-independent", () => {
    const a = item({ kind: "ARXIV", externalId: "2607.22534v1", arxivId: "2607.22534" });
    const b = item({ kind: "HUGGINGFACE", externalId: "2607.22534", arxivId: "2607.22534" });
    const c = item({ kind: "HACKERNEWS", externalId: "999" });

    const forward = clusterItems([a, b, c]);
    const reverse = clusterItems([c, b, a]);

    expect(forward.map((x) => x.id)).toEqual(reverse.map((x) => x.id));
    expect(forward.map((x) => x.primary.externalId)).toEqual(
      reverse.map((x) => x.primary.externalId),
    );
  });

  it("gives a paper with no arXiv id a cluster of its own rather than merging on null", () => {
    const clusters = clusterItems([
      item({ kind: "ARXIV", externalId: "odd-1", arxivId: null }),
      item({ kind: "ARXIV", externalId: "odd-2", arxivId: null }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it("returns nothing for an empty corpus", () => {
    expect(clusterItems([])).toEqual([]);
  });
});

describe("clusterItems against the real fixture corpus", () => {
  const corpus = loadCorpus();
  const clusters = clusterItems(corpus);

  it("finds the measured cross-source pairs", () => {
    const multiSource = clusters.filter((c) => c.sourceCount > 1);

    // 91 arXiv↔HF pairs were measured when the fixtures were captured.
    expect(multiSource.length).toBeGreaterThanOrEqual(50);
    for (const cluster of multiSource) {
      const kinds = new Set(cluster.items.map((i) => i.kind));
      expect(kinds).toEqual(new Set(["ARXIV", "HUGGINGFACE"]));
    }
  });

  it("loses no items — every input appears in exactly one cluster", () => {
    const clustered = clusters.flatMap((c) => c.items);
    expect(clustered).toHaveLength(corpus.length);
  });

  it("leaves every Hacker News item in a cluster of one", () => {
    const hnClusters = clusters.filter((c) => c.items.some((i) => i.kind === "HACKERNEWS"));

    expect(hnClusters.length).toBeGreaterThan(0);
    for (const cluster of hnClusters) {
      expect(cluster.items).toHaveLength(1);
      expect(cluster.sourceCount).toBe(1);
    }
  });

  it("does not over-merge — most clusters are single-source", () => {
    // The fixture holds 300 deliberately unjoined arXiv papers as negatives.
    const singles = clusters.filter((c) => c.sourceCount === 1);
    expect(singles.length).toBeGreaterThan(clusters.length / 2);
  });
});

describe("dedupeWithinSource", () => {
  it("collapses the same record fetched twice", () => {
    const deduped = dedupeWithinSource([
      item({ kind: "HUGGINGFACE", externalId: "2607.1", signals: { upvotes: 10 } }),
      item({ kind: "HUGGINGFACE", externalId: "2607.1", signals: { upvotes: 50 } }),
    ]);

    expect(deduped).toHaveLength(1);
  });

  it("keeps the fresher snapshot, since signals grow over time", () => {
    const deduped = dedupeWithinSource([
      item({
        kind: "HUGGINGFACE",
        externalId: "2607.1",
        publishedAt: new Date("2026-07-20T00:00:00Z"),
        signals: { upvotes: 10 },
      }),
      item({
        kind: "HUGGINGFACE",
        externalId: "2607.1",
        publishedAt: new Date("2026-07-22T00:00:00Z"),
        signals: { upvotes: 50 },
      }),
    ]);

    expect(deduped[0].signals.upvotes).toBe(50);
  });

  it("does not collapse the same id across different sources", () => {
    const deduped = dedupeWithinSource([
      item({ kind: "ARXIV", externalId: "2607.1" }),
      item({ kind: "HUGGINGFACE", externalId: "2607.1" }),
    ]);

    expect(deduped).toHaveLength(2);
  });

  it("runs before clustering so a double-fetched paper does not inflate sourceCount", () => {
    const raw = [
      item({ kind: "ARXIV", externalId: "2607.22534v1", arxivId: "2607.22534" }),
      item({ kind: "ARXIV", externalId: "2607.22534v1", arxivId: "2607.22534" }),
      item({ kind: "HUGGINGFACE", externalId: "2607.22534", arxivId: "2607.22534" }),
    ];

    const clusters = clusterItems(dedupeWithinSource(raw));

    expect(clusters).toHaveLength(1);
    expect(clusters[0].sourceCount).toBe(2);
    expect(clusters[0].items).toHaveLength(2);
  });
});

describe("clustering a GitHub repo with its Hacker News coverage", () => {
  const repo = () =>
    item({
      kind: "GITHUB",
      externalId: "839428333",
      title: "huggingface/speech-to-speech",
      canonicalUrl: "https://github.com/huggingface/speech-to-speech",
      signals: { starsToday: 627, stars: 8280 },
    });

  /**
   * Measured 2026-07-30: 0 of 21 trending repos also appeared on HN, so this
   * fires rarely. It is kept because the cost is one join key and the failure
   * it prevents — the same repo twice in one feed — is the most visible kind.
   */
  it("merges an HN story that links the same repo", () => {
    const clusters = clusterItems([
      repo(),
      item({
        kind: "HACKERNEWS",
        externalId: "hn-1",
        title: "Show HN: local voice agents",
        canonicalUrl: "https://github.com/huggingface/speech-to-speech",
      }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].items).toHaveLength(2);
  });

  /** The repo is the development; the thread is coverage of it. */
  it("makes the repo the representative, not the thread", () => {
    const clusters = clusterItems([
      item({
        kind: "HACKERNEWS",
        externalId: "hn-1",
        title: "Show HN: local voice agents",
        canonicalUrl: "https://github.com/huggingface/speech-to-speech",
      }),
      repo(),
    ]);

    expect(clusters[0].primary.kind).toBe("GITHUB");
  });

  it("matches despite a deep link, casing, or a .git suffix", () => {
    for (const url of [
      "https://github.com/HuggingFace/Speech-To-Speech",
      "https://github.com/huggingface/speech-to-speech/blob/main/README.md",
      "https://github.com/huggingface/speech-to-speech/tree/main/src",
      "https://github.com/huggingface/speech-to-speech.git",
      "https://www.github.com/huggingface/speech-to-speech",
    ]) {
      const clusters = clusterItems([
        repo(),
        item({ kind: "HACKERNEWS", externalId: `hn-${url.length}`, canonicalUrl: url }),
      ]);
      expect(clusters, url).toHaveLength(1);
    }
  });

  it("does not merge an HN story about a different repo", () => {
    const clusters = clusterItems([
      repo(),
      item({
        kind: "HACKERNEWS",
        externalId: "hn-2",
        canonicalUrl: "https://github.com/someone/unrelated",
      }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  /** A non-repo GitHub URL must not become a join key. */
  it("ignores GitHub URLs that are not repositories", () => {
    const clusters = clusterItems([
      item({ kind: "HACKERNEWS", externalId: "hn-3", canonicalUrl: "https://github.com/features" }),
      item({ kind: "HACKERNEWS", externalId: "hn-4", canonicalUrl: "https://github.com/pricing" }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it("keeps two unrelated repos as separate clusters", () => {
    const clusters = clusterItems([
      repo(),
      item({
        kind: "GITHUB",
        externalId: "999",
        title: "vllm-project/vllm",
        canonicalUrl: "https://github.com/vllm-project/vllm",
      }),
    ]);

    expect(clusters).toHaveLength(2);
  });
});

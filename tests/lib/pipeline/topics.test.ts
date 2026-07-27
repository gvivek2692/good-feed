/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

import { type GenerateImpl } from "@/lib/llm/client";
import { type Cluster } from "@/lib/pipeline/clustering";
import { classifyCluster, CONFIDENCE_THRESHOLD, MAX_TOPICS_PER_ITEM } from "@/lib/pipeline/topics";
import { isTopicSlug, TOPIC_SLUGS, TOPICS } from "@/lib/topics/taxonomy";
import { type NormalizedItem } from "@/lib/sources/types";

function item(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    externalId: "2607.22534v1",
    kind: "ARXIV",
    title: "FlashLite: Faster Attention Kernels for Long-Context Serving",
    authors: ["Ada Lovelace"],
    publishedAt: new Date("2026-07-20T00:00:00Z"),
    canonicalUrl: "https://arxiv.org/abs/2607.22534",
    sourceUrl: "https://arxiv.org/abs/2607.22534",
    text: "We propose FlashLite, a CUDA kernel that reduces attention memory during serving.",
    arxivId: "2607.22534",
    signals: {},
    raw: {},
    ...overrides,
  };
}

function cluster(items: NormalizedItem[] = [item()]): Cluster {
  return {
    id: `arxiv:${items[0].arxivId ?? items[0].externalId}`,
    items,
    sourceCount: new Set(items.map((i) => i.kind)).size,
    primary: items[0],
  };
}

function respondWith(payload: unknown): GenerateImpl {
  return async () => ({ text: JSON.stringify(payload) });
}

describe("taxonomy", () => {
  it("holds exactly the 15 topics the spec fixed", () => {
    expect(TOPICS).toHaveLength(15);
  });

  it("has unique slugs", () => {
    expect(new Set(TOPIC_SLUGS).size).toBe(TOPIC_SLUGS.length);
  });

  it("recognizes a real slug and rejects an invented one", () => {
    expect(isTopicSlug("inference-optimization")).toBe(true);
    expect(isTopicSlug("quantum-computing")).toBe(false);
  });

  it("uses kebab-case slugs throughout, matching the seed", () => {
    for (const slug of TOPIC_SLUGS) {
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});

describe("classifyCluster", () => {
  it("returns assignments for well-formed output", async () => {
    const result = await classifyCluster(cluster(), {
      generateImpl: respondWith({
        topics: [
          { slug: "inference-optimization", confidence: 0.95 },
          { slug: "hardware-systems", confidence: 0.8 },
        ],
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topics.map((t) => t.slug)).toEqual([
      "inference-optimization",
      "hardware-systems",
    ]);
  });

  /**
   * The acceptance criterion. A model inventing a plausible-sounding slug must
   * not have it written to ItemTopic — the row would fail against a taxonomy the
   * database has never seen.
   */
  it("drops a slug that is not in the fixed taxonomy", async () => {
    const result = await classifyCluster(cluster(), {
      generateImpl: respondWith({
        topics: [
          { slug: "inference-optimization", confidence: 0.9 },
          { slug: "quantum-computing", confidence: 0.9 },
        ],
      }),
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.topics.map((t) => t.slug)).toEqual(["inference-optimization"]);
    expect(result.value.rejected).toContain("quantum-computing");
  });

  it("stores confidence per assignment", async () => {
    const result = await classifyCluster(cluster(), {
      generateImpl: respondWith({ topics: [{ slug: "agents", confidence: 0.72 }] }),
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.topics[0].confidence).toBeCloseTo(0.72);
  });

  /**
   * Spec: items matching no topic above threshold are stored unclassified
   * rather than force-fit. A weak guess is worse than no topic — it puts the
   * item in a feed the user asked for on false pretenses.
   */
  it("leaves an item unclassified rather than force-fitting a low-confidence topic", async () => {
    const result = await classifyCluster(cluster(), {
      generateImpl: respondWith({
        topics: [{ slug: "agents", confidence: CONFIDENCE_THRESHOLD - 0.1 }],
      }),
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.topics).toEqual([]);
    expect(result.value.unclassified).toBe(true);
  });

  it("keeps a topic exactly at the threshold", async () => {
    const result = await classifyCluster(cluster(), {
      generateImpl: respondWith({
        topics: [{ slug: "agents", confidence: CONFIDENCE_THRESHOLD }],
      }),
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.topics).toHaveLength(1);
    expect(result.value.unclassified).toBe(false);
  });

  it("accepts an empty topic list as unclassified, not an error", async () => {
    const result = await classifyCluster(cluster(), {
      generateImpl: respondWith({ topics: [] }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unclassified).toBe(true);
  });

  it("is multi-label — an item may carry several topics", async () => {
    const result = await classifyCluster(cluster(), {
      generateImpl: respondWith({
        topics: [
          { slug: "multimodal", confidence: 0.9 },
          { slug: "vision", confidence: 0.85 },
          { slug: "robotics", confidence: 0.7 },
        ],
      }),
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.topics).toHaveLength(3);
  });

  it("caps runaway output so one item cannot claim the whole taxonomy", async () => {
    const result = await classifyCluster(cluster(), {
      generateImpl: respondWith({
        topics: TOPIC_SLUGS.map((slug) => ({ slug, confidence: 0.9 })),
      }),
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.topics).toHaveLength(MAX_TOPICS_PER_ITEM);
  });

  it("keeps the highest-confidence topics when capping", async () => {
    const result = await classifyCluster(cluster(), {
      generateImpl: respondWith({
        topics: [
          { slug: "agents", confidence: 0.6 },
          { slug: "vision", confidence: 0.99 },
          { slug: "rag", confidence: 0.7 },
          { slug: "reasoning", confidence: 0.95 },
          { slug: "evaluation", confidence: 0.65 },
        ],
      }),
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.topics[0].slug).toBe("vision");
    expect(result.value.topics.map((t) => t.slug)).not.toContain("agents");
  });

  it("deduplicates a slug the model emitted twice", async () => {
    const result = await classifyCluster(cluster(), {
      generateImpl: respondWith({
        topics: [
          { slug: "agents", confidence: 0.9 },
          { slug: "agents", confidence: 0.7 },
        ],
      }),
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.topics).toHaveLength(1);
    expect(result.value.topics[0].confidence).toBeCloseTo(0.9);
  });

  it("returns an error rather than partial data on malformed output", async () => {
    vi.useFakeTimers();
    const promise = classifyCluster(cluster(), {
      maxRetries: 0,
      generateImpl: respondWith({ notTopics: [] }),
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalidResponse");
  });

  it("sends the taxonomy to the model so it classifies into the fixed list", async () => {
    const prompts: string[] = [];
    const generateImpl: GenerateImpl = async (args) => {
      prompts.push(args.contents);
      return { text: JSON.stringify({ topics: [{ slug: "agents", confidence: 0.9 }] }) };
    };

    await classifyCluster(cluster(), { generateImpl });

    for (const slug of TOPIC_SLUGS) {
      expect(prompts[0]).toContain(slug);
    }
  });

  it("classifies from the title alone when an item has no text", async () => {
    const result = await classifyCluster(cluster([item({ text: null })]), {
      generateImpl: respondWith({ topics: [{ slug: "inference-optimization", confidence: 0.8 }] }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topics).toHaveLength(1);
  });

  it("clamps a confidence the model reports outside 0..1", async () => {
    const result = await classifyCluster(cluster(), {
      generateImpl: respondWith({
        topics: [
          { slug: "agents", confidence: 1.4 },
          { slug: "vision", confidence: -0.2 },
        ],
      }),
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.topics[0].confidence).toBe(1);
    expect(result.value.topics.map((t) => t.slug)).not.toContain("vision");
  });
});

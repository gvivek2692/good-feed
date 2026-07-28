/**
 * Idempotency lives in the database's unique constraints, so these run against
 * real Postgres rather than a mock. Skipped when DATABASE_URL is absent.
 * @vitest-environment node
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { type Cluster } from "@/lib/pipeline/clustering";
import { persistCluster, type PersistableCluster } from "@/lib/pipeline/persist";
import { buildDistributions, scoreCluster } from "@/lib/ranking/score";
import { type NormalizedItem } from "@/lib/sources/types";

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const NOW = new Date("2026-07-27T12:00:00Z");

function item(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    externalId: "persist-test-1",
    kind: "HUGGINGFACE",
    title: "A Paper About Attention",
    authors: ["Ada Lovelace"],
    publishedAt: new Date("2026-07-26T12:00:00Z"),
    canonicalUrl: "https://huggingface.co/papers/2607.1",
    sourceUrl: "https://huggingface.co/papers/2607.1",
    text: "We reduce memory use by 40% versus FlashAttention-2.",
    arxivId: "2607.1",
    signals: { upvotes: 120, comments: 2, githubStars: 40 },
    raw: { upvotes: 120 },
    ...overrides,
  };
}

function cluster(items: NormalizedItem[] = [item()]): Cluster {
  return {
    id: `test-cluster-${items[0].externalId}`,
    items,
    sourceCount: new Set(items.map((i) => i.kind)).size,
    primary: items[0],
  };
}

function payload(overrides: Partial<PersistableCluster> = {}): PersistableCluster {
  const target = overrides.cluster ?? cluster();
  const distributions = buildDistributions([target], "seeded", NOW);
  const scored = scoreCluster(target, distributions, NOW);

  return {
    cluster: target,
    headline: "Attention method cuts serving memory by 40%",
    summary: "A method that reduces attention memory during serving.",
    whyItMatters: "It reduces memory use by 40% versus FlashAttention-2.",
    claims: [
      {
        text: "reduces memory use by 40% versus FlashAttention-2",
        quotedFrom: "reduces memory use by 40% versus FlashAttention-2",
      },
    ],
    topics: [{ slug: "inference-optimization", confidence: 0.9 }],
    score: scored.score,
    snapshot: scored.snapshot,
    ...overrides,
  };
}

describeDb("persistCluster", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString! }),
  });

  beforeEach(async () => {
    await prisma.source.deleteMany({ where: { externalId: { startsWith: "persist-test" } } });
  });

  afterAll(async () => {
    await prisma.source.deleteMany({ where: { externalId: { startsWith: "persist-test" } } });
    await prisma.$disconnect();
  });

  it("writes a source, an item, its claims, and its topics", async () => {
    const result = await persistCluster(prisma, payload());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await prisma.item.findUnique({
      where: { id: result.value.itemId },
      include: { claims: true, topics: true, source: true },
    });

    expect(stored?.title).toBe("A Paper About Attention");
    expect(stored?.claims).toHaveLength(1);
    expect(stored?.topics).toHaveLength(1);
    expect(stored?.source.kind).toBe("HUGGINGFACE");
    expect(stored?.published).toBe(true);
  });

  /** The acceptance criterion: re-running over the same window creates no duplicates. */
  it("creates no duplicate rows when the same cluster is persisted twice", async () => {
    const first = await persistCluster(prisma, payload());
    const second = await persistCluster(prisma, payload());

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.itemId).toBe(first.value.itemId);

    const sources = await prisma.source.count({
      where: { externalId: { startsWith: "persist-test" } },
    });
    const items = await prisma.item.count({
      where: { source: { externalId: { startsWith: "persist-test" } } },
    });

    expect(sources).toBe(1);
    expect(items).toBe(1);
  });

  it("replaces claims on re-persist rather than accumulating them", async () => {
    await persistCluster(prisma, payload());
    const second = await persistCluster(
      prisma,
      payload({
        claims: [{ text: "a different claim", quotedFrom: "different quoted text" }],
      }),
    );

    if (!second.ok) throw new Error("expected success");
    const claims = await prisma.claim.findMany({ where: { itemId: second.value.itemId } });

    expect(claims).toHaveLength(1);
    expect(claims[0].text).toBe("a different claim");
  });

  it("updates the score and snapshot when a cluster is re-ranked", async () => {
    await persistCluster(prisma, payload({ score: 0.2 }));
    const second = await persistCluster(prisma, payload({ score: 0.9 }));

    if (!second.ok) throw new Error("expected success");
    const stored = await prisma.item.findUnique({ where: { id: second.value.itemId } });

    expect(stored?.importanceScore).toBeCloseTo(0.9);
  });

  it("stores the signal snapshot as queryable JSON, not a string", async () => {
    const result = await persistCluster(prisma, payload());
    if (!result.ok) throw new Error("expected success");

    const stored = await prisma.item.findUnique({ where: { id: result.value.itemId } });
    const snapshot = stored?.signalSnapshot as Record<string, unknown>;

    expect(snapshot.cluster).toBe("research");
    expect(snapshot.distributionSource).toBe("seeded");
    expect(snapshot.percentiles).toBeTypeOf("object");
  });

  /**
   * A take stripped empty by claim validation still publishes with its summary,
   * per the spec. It must not be silently dropped at persistence instead.
   */
  it("publishes an item whose take was stripped empty, with summary only", async () => {
    const result = await persistCluster(prisma, payload({ whyItMatters: "", claims: [] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await prisma.item.findUnique({
      where: { id: result.value.itemId },
      include: { claims: true },
    });

    expect(stored?.published).toBe(true);
    expect(stored?.summary).toBeTruthy();
    expect(stored?.claims).toHaveLength(0);
  });

  it("stores an unclassified item rather than refusing it", async () => {
    const result = await persistCluster(prisma, payload({ topics: [] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const topics = await prisma.itemTopic.findMany({ where: { itemId: result.value.itemId } });
    expect(topics).toHaveLength(0);
  });

  it("rejects a topic slug that is not in the seeded taxonomy", async () => {
    const result = await persistCluster(
      prisma,
      // @ts-expect-error deliberately invalid slug, as a hallucinating model would emit
      payload({ topics: [{ slug: "not-a-real-topic", confidence: 0.9 }] }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unknown-topic");
  });

  it("records every source in a multi-source cluster, publishing only the primary", async () => {
    const multi = cluster([
      item({ externalId: "persist-test-hf", kind: "HUGGINGFACE" }),
      item({ externalId: "persist-test-ax", kind: "ARXIV" }),
    ]);
    const result = await persistCluster(prisma, payload({ cluster: multi }));

    if (!result.ok) throw new Error("expected success");

    const sources = await prisma.source.findMany({
      where: { externalId: { startsWith: "persist-test" } },
    });
    const items = await prisma.item.findMany({
      where: { source: { externalId: { startsWith: "persist-test" } } },
    });

    expect(sources).toHaveLength(2);
    expect(items).toHaveLength(1);
    expect(items[0].clusterId).toBe(multi.id);
  });

  it("attaches each claim to a source url a reader can verify", async () => {
    const result = await persistCluster(prisma, payload());
    if (!result.ok) throw new Error("expected success");

    const claims = await prisma.claim.findMany({ where: { itemId: result.value.itemId } });
    expect(claims[0].sourceUrl).toBe("https://huggingface.co/papers/2607.1");
  });
});

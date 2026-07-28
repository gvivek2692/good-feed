/**
 * Resumability rests on rows actually being in the database, so these run
 * against real Postgres. Skipped when DATABASE_URL is absent.
 * @vitest-environment node
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { runPipeline, type PipelineDeps } from "@/lib/pipeline/runner";
import { ok } from "@/lib/result";
import { type NormalizedItem } from "@/lib/sources/types";

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const NOW = new Date("2026-07-27T12:00:00Z");

function item(id: string, overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    externalId: `runner-test-${id}`,
    kind: "HUGGINGFACE",
    title: `Paper ${id}`,
    authors: ["Ada Lovelace"],
    publishedAt: new Date("2026-07-26T12:00:00Z"),
    canonicalUrl: `https://huggingface.co/papers/${id}`,
    sourceUrl: `https://huggingface.co/papers/${id}`,
    text: "We propose a method that reduces memory use by 40% versus FlashAttention-2.",
    arxivId: id,
    signals: { upvotes: 120, comments: 2, githubStars: 40 },
    raw: {},
    ...overrides,
  };
}

/** Deps that succeed for everything, so each test can break exactly one thing. */
function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    fetchSources: async () => [ok([item("a"), item("b"), item("c")])],
    summarize: async (cluster) =>
      ok({
        clusterId: cluster.id,
        headline: "Attention method cuts serving memory by 40%",
        summary: "A method that reduces attention memory.",
        whyItMatters: "It reduces memory use by 40% versus FlashAttention-2.",
        claims: [
          {
            text: "reduces memory use by 40% versus FlashAttention-2",
            quotedFrom: "reduces memory use by 40% versus FlashAttention-2",
          },
        ],
        quotableSource:
          "We propose a method that reduces memory use by 40% versus FlashAttention-2.",
      }),
    classify: async (cluster) =>
      ok({
        clusterId: cluster.id,
        topics: [{ slug: "inference-optimization" as const, confidence: 0.9 }],
        unclassified: false,
        rejected: [],
      }),
    now: () => NOW,
    ...overrides,
  };
}

describeDb("runPipeline", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString! }),
  });

  async function cleanup(): Promise<void> {
    await prisma.source.deleteMany({ where: { externalId: { startsWith: "runner-test" } } });
    await prisma.pipelineRun.deleteMany({ where: { id: { startsWith: "runner-" } } });
  }

  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("publishes items end to end and records a completed run", async () => {
    const result = await runPipeline(prisma, deps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const run = await prisma.pipelineRun.findUnique({ where: { id: result.value.runId } });
    expect(run?.status).toBe("COMPLETED");
    expect(run?.finishedAt).toBeTruthy();

    const items = await prisma.item.count({
      where: { source: { externalId: { startsWith: "runner-test" } } },
    });
    expect(items).toBe(3);
  });

  it("records per-stage counts in the run log", async () => {
    const result = await runPipeline(prisma, deps());
    if (!result.ok) throw new Error("expected success");

    const run = await prisma.pipelineRun.findUnique({ where: { id: result.value.runId } });
    const counts = run?.stageCounts as Record<string, number>;

    expect(counts.fetched).toBe(3);
    expect(counts.clustered).toBe(3);
    expect(counts.summarized).toBe(3);
    expect(counts.published).toBe(3);
    expect(counts.dropped).toBe(0);
  });

  /** Acceptance criterion: one failing item must not abort the batch. */
  it("continues past an item whose summarization fails", async () => {
    const result = await runPipeline(
      prisma,
      deps({
        summarize: async (cluster) => {
          if (cluster.primary.externalId === "runner-test-b") {
            return { ok: false, error: { kind: "invalidResponse", message: "bad output" } };
          }
          return deps().summarize(cluster);
        },
      }),
    );

    if (!result.ok) throw new Error("expected success");

    const items = await prisma.item.count({
      where: { source: { externalId: { startsWith: "runner-test" } } },
    });
    expect(items).toBe(2);

    const run = await prisma.pipelineRun.findUnique({ where: { id: result.value.runId } });
    expect(run?.status).toBe("COMPLETED");
  });

  /** Acceptance criterion: every drop carries a reason. */
  it("records a reason and stage for each dropped item", async () => {
    const result = await runPipeline(
      prisma,
      deps({
        summarize: async (cluster) => {
          if (cluster.primary.externalId === "runner-test-b") {
            return { ok: false, error: { kind: "invalidResponse", message: "bad output" } };
          }
          return deps().summarize(cluster);
        },
      }),
    );

    if (!result.ok) throw new Error("expected success");

    const drops = await prisma.droppedItem.findMany({ where: { runId: result.value.runId } });

    expect(drops).toHaveLength(1);
    expect(drops[0].stage).toBe("summarize");
    expect(drops[0].reason).toBeTruthy();
    expect(drops[0].externalId).toBe("runner-test-b");
  });

  it("drops an item below the absolute floor with a ranking reason, not silently", async () => {
    const result = await runPipeline(
      prisma,
      deps({ fetchSources: async () => [ok([item("weak", { signals: { upvotes: 1 } })])] }),
    );

    if (!result.ok) throw new Error("expected success");

    const drops = await prisma.droppedItem.findMany({ where: { runId: result.value.runId } });
    expect(drops).toHaveLength(1);
    expect(drops[0].stage).toBe("rank");
    expect(drops[0].reason).toBe("below-absolute-floor");
  });

  it("strips an unsupported assertion before the item is persisted", async () => {
    const result = await runPipeline(
      prisma,
      deps({
        fetchSources: async () => [ok([item("a")])],
        summarize: async (cluster) =>
          ok({
            clusterId: cluster.id,
            headline: "A method for long-context attention",
            summary: "A method for attention.",
            whyItMatters: "It reduces memory use. It outperforms every prior method.",
            claims: [],
            quotableSource:
              "We propose a method that reduces memory use by 40% versus FlashAttention-2.",
          }),
      }),
    );

    if (!result.ok) throw new Error("expected success");

    const stored = await prisma.item.findFirst({
      where: { source: { externalId: "runner-test-a" } },
    });

    expect(stored?.whyItMatters).not.toContain("outperforms");
    expect(stored?.published).toBe(true);
  });

  /**
   * Found on the first live run: an untopiced opinion piece ranked second in
   * the feed. The feed is filtered by the topics a user selected, so an item
   * with no topic is unreachable for every user — publishing one fills a slot
   * with something nobody can see.
   */
  it("does not publish an item the classifier could not place in any topic", async () => {
    const result = await runPipeline(
      prisma,
      deps({
        fetchSources: async () => [ok([item("a")])],
        classify: async (cluster) =>
          ok({ clusterId: cluster.id, topics: [], unclassified: true, rejected: [] }),
      }),
    );

    if (!result.ok) throw new Error("expected success");

    expect(result.value.published).toBe(0);
    expect(result.value.dropped).toBe(1);

    const drops = await prisma.droppedItem.findMany({ where: { runId: result.value.runId } });
    expect(drops[0].stage).toBe("classify");
    expect(drops[0].reason).toBe("unclassified");
  });

  /**
   * Regression: stripping an assertion was originally counted as a dropped
   * item, so a run that published all three items reported "dropped: 3". A
   * dropped item is absent from the feed; a stripped assertion is a published
   * item with a trimmed take. The run log must not conflate them.
   */
  it("counts a stripped assertion separately from a dropped item", async () => {
    const result = await runPipeline(
      prisma,
      deps({
        fetchSources: async () => [ok([item("a")])],
        summarize: async (cluster) =>
          ok({
            clusterId: cluster.id,
            headline: "A method for long-context attention",
            summary: "A method for attention.",
            whyItMatters: "It reduces memory use. It outperforms every prior method.",
            claims: [],
            quotableSource: "We propose a method that reduces memory use.",
          }),
      }),
    );

    if (!result.ok) throw new Error("expected success");

    expect(result.value.published).toBe(1);
    expect(result.value.dropped).toBe(0);
    expect(result.value.assertionsStripped).toBe(1);

    // The strip is still recorded, so a run log shows what was removed.
    const drops = await prisma.droppedItem.findMany({ where: { runId: result.value.runId } });
    expect(drops.some((drop) => drop.stage === "validate")).toBe(true);
  });

  /**
   * The acceptance criterion this task exists for. Persistence is idempotent on
   * (kind, externalId), so a run interrupted partway leaves finished work in
   * place and the next run completes the rest without duplicating anything.
   */
  it("resumes after a run killed mid-batch, without duplicating completed work", async () => {
    const killed = await runPipeline(
      prisma,
      deps({
        summarize: async (cluster) => {
          if (cluster.primary.externalId === "runner-test-c") {
            throw new Error("process killed mid-batch");
          }
          return deps().summarize(cluster);
        },
      }),
    );

    expect(killed.ok).toBe(false);

    const afterCrash = await prisma.item.count({
      where: { source: { externalId: { startsWith: "runner-test" } } },
    });
    expect(afterCrash).toBeGreaterThan(0);
    expect(afterCrash).toBeLessThan(3);

    const resumed = await runPipeline(prisma, deps());
    expect(resumed.ok).toBe(true);

    const finalCount = await prisma.item.count({
      where: { source: { externalId: { startsWith: "runner-test" } } },
    });
    expect(finalCount).toBe(3);
  });

  it("marks a crashed run FAILED with its error, rather than leaving it RUNNING", async () => {
    await runPipeline(
      prisma,
      deps({
        summarize: async () => {
          throw new Error("process killed mid-batch");
        },
      }),
    );

    const run = await prisma.pipelineRun.findFirst({ orderBy: { startedAt: "desc" } });

    expect(run?.status).toBe("FAILED");
    expect(run?.error).toContain("killed");
    expect(run?.finishedAt).toBeTruthy();
  });

  it("skips re-summarizing an item already published, so a resume costs no API calls", async () => {
    await runPipeline(prisma, deps());

    const summarized: string[] = [];
    await runPipeline(
      prisma,
      deps({
        summarize: async (cluster) => {
          summarized.push(cluster.primary.externalId);
          return deps().summarize(cluster);
        },
      }),
    );

    expect(summarized).toEqual([]);
  });

  it("survives a source that fails entirely, using the sources that succeeded", async () => {
    const result = await runPipeline(
      prisma,
      deps({
        fetchSources: async () => [
          ok([item("a")]),
          { ok: false, error: { kind: "network" as const, message: "arxiv unreachable" } },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const items = await prisma.item.count({
      where: { source: { externalId: { startsWith: "runner-test" } } },
    });
    expect(items).toBe(1);

    const drops = await prisma.droppedItem.findMany({ where: { runId: result.value.runId } });
    expect(drops.some((drop) => drop.stage === "fetch")).toBe(true);
  });

  it("fails the run when every source fails, rather than reporting an empty success", async () => {
    const result = await runPipeline(
      prisma,
      deps({
        fetchSources: async () => [
          { ok: false, error: { kind: "network" as const, message: "all down" } },
        ],
      }),
    );

    expect(result.ok).toBe(false);
  });
});

import { type PrismaClient } from "@/generated/prisma/client";
import { type LlmError } from "@/lib/llm/client";
import { validateClaims } from "@/lib/pipeline/claims";
import { clusterItems, dedupeWithinSource, type Cluster } from "@/lib/pipeline/clustering";
import { persistCluster } from "@/lib/pipeline/persist";
import { type ClassifiedCluster } from "@/lib/pipeline/topics";
import { type SummarizedCluster } from "@/lib/pipeline/summarize";
import { buildDistributions, rankClusters } from "@/lib/ranking/score";
import { err, ok, type Result } from "@/lib/result";
import { type NormalizedItem, type SourceError } from "@/lib/sources/types";

/**
 * Every collaborator the runner calls out to, injected.
 *
 * The stages are already tested in isolation; this seam lets the runner's own
 * concerns — sequencing, error isolation, logging, resume — be tested without
 * network or API calls.
 */
export interface PipelineDeps {
  fetchSources: () => Promise<Array<Result<NormalizedItem[], SourceError>>>;
  summarize: (cluster: Cluster) => Promise<Result<SummarizedCluster, LlmError>>;
  classify: (cluster: Cluster) => Promise<Result<ClassifiedCluster, LlmError>>;
  now: () => Date;
}

export interface RunSummary {
  runId: string;
  fetched: number;
  clustered: number;
  summarized: number;
  published: number;
  /** Items that did not reach the feed. */
  dropped: number;
  /**
   * Assertions stripped from takes that *did* publish.
   *
   * Counted separately from `dropped` on purpose: a dropped item is absent from
   * the feed, while a stripped assertion is a published item with a trimmed
   * take. Collapsing them would have reported "dropped: 3" on a run that
   * published all three items — which is how this distinction was found.
   */
  assertionsStripped: number;
}

export type RunError =
  { kind: "all-sources-failed"; message: string } | { kind: "crashed"; message: string };

interface Drop {
  stage: string;
  reason: string;
  externalId?: string;
  detail?: unknown;
  /**
   * True when the item still published and only an assertion was removed.
   * Logged like any other drop so run logs stay complete, but excluded from
   * the dropped-item count.
   */
  assertionOnly?: boolean;
}

/**
 * Runs one full pipeline pass: fetch → dedupe → cluster → rank → summarize →
 * validate → classify → persist.
 *
 * Ranking runs before summarization on purpose. Summarizing is the expensive
 * stage, and an item that cannot clear the absolute floor will never reach the
 * feed — paying for a summary first would burn quota on items that are then
 * discarded.
 *
 * Resume needs no extra bookkeeping: persistence is idempotent on
 * `(kind, externalId)`, so an interrupted run leaves completed items in place
 * and the next pass skips them by checking what is already published. That is
 * correct after a crash at any point, which a separate progress table would
 * only be if it were updated in the same transaction as the write.
 */
export async function runPipeline(
  prisma: PrismaClient,
  deps: PipelineDeps,
): Promise<Result<RunSummary, RunError>> {
  const run = await prisma.pipelineRun.create({ data: { status: "RUNNING" } });
  const drops: Drop[] = [];

  const finish = async (
    status: "COMPLETED" | "FAILED",
    counts: Omit<RunSummary, "runId">,
    error?: string,
  ): Promise<void> => {
    if (drops.length > 0) {
      await prisma.droppedItem.createMany({
        data: drops.map((drop) => ({
          runId: run.id,
          stage: drop.stage,
          reason: drop.reason,
          externalId: drop.externalId ?? null,
          detail: (drop.detail ?? undefined) as object | undefined,
        })),
      });
    }

    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt: new Date(),
        stageCounts: counts as unknown as object,
        error: error ?? null,
      },
    });
  };

  const counts = {
    fetched: 0,
    clustered: 0,
    summarized: 0,
    published: 0,
    dropped: 0,
    assertionsStripped: 0,
  };

  /** Items absent from the feed; stripped assertions are tallied separately. */
  const tally = (): void => {
    counts.dropped = drops.filter((drop) => !drop.assertionOnly).length;
    counts.assertionsStripped = drops.filter((drop) => drop.assertionOnly).length;
  };

  try {
    // --- fetch -------------------------------------------------------------
    const results = await deps.fetchSources();
    const items: NormalizedItem[] = [];

    for (const result of results) {
      if (result.ok) items.push(...result.value);
      // A single source failing loses that source, not the run. Only a total
      // failure is fatal — an empty feed would otherwise look like a quiet day.
      else drops.push({ stage: "fetch", reason: result.error.kind, detail: result.error });
    }

    if (items.length === 0) {
      const message = "every source failed or returned nothing";
      tally();
      await finish("FAILED", counts, message);
      return err({ kind: "all-sources-failed", message });
    }

    counts.fetched = items.length;

    // --- dedupe and cluster ------------------------------------------------
    const clusters = clusterItems(dedupeWithinSource(items));
    counts.clustered = clusters.length;

    // --- rank --------------------------------------------------------------
    const now = deps.now();
    const distributions = buildDistributions(clusters, "seeded", now);
    const ranked = rankClusters(clusters, distributions, now);

    for (const entry of ranked) {
      if (!entry.included) {
        drops.push({
          stage: "rank",
          reason: entry.exclusionReason ?? "below-absolute-floor",
          externalId: entry.cluster.primary.externalId,
          detail: { score: entry.score },
        });
      }
    }

    const included = ranked.filter((entry) => entry.included);

    // --- resume ------------------------------------------------------------
    // Anything already published in a previous pass is skipped, so a resumed
    // run costs no API calls for work that is already done.
    const existing = await prisma.item.findMany({
      where: {
        published: true,
        source: {
          externalId: { in: included.map((entry) => entry.cluster.primary.externalId) },
        },
      },
      select: { source: { select: { externalId: true, kind: true } } },
    });
    const done = new Set(existing.map((row) => `${row.source.kind}:${row.source.externalId}`));

    const pending = included.filter(
      (entry) => !done.has(`${entry.cluster.primary.kind}:${entry.cluster.primary.externalId}`),
    );

    // --- per item ----------------------------------------------------------
    for (const entry of pending) {
      const { cluster } = entry;
      const externalId = cluster.primary.externalId;

      const summarized = await deps.summarize(cluster);
      if (!summarized.ok) {
        drops.push({
          stage: "summarize",
          reason: summarized.error.kind,
          externalId,
          detail: { message: summarized.error.message },
        });
        continue;
      }
      counts.summarized += 1;

      // Unsupported assertions are stripped before anything is written, so an
      // ungrounded take cannot reach the database even transiently.
      const validated = validateClaims({
        whyItMatters: summarized.value.whyItMatters,
        claims: summarized.value.claims,
        quotableSource: summarized.value.quotableSource,
      });

      for (const rejection of validated.rejected) {
        drops.push({
          stage: "validate",
          reason: rejection.reason,
          externalId,
          detail: { sentence: rejection.sentence, quotedFrom: rejection.quotedFrom },
          assertionOnly: true,
        });
      }

      const classified = await deps.classify(cluster);
      if (!classified.ok) {
        drops.push({
          stage: "classify",
          reason: classified.error.kind,
          externalId,
          detail: { message: classified.error.message },
        });
        continue;
      }

      // The feed is filtered by the topics a user selected, so an item with no
      // topic can never appear for anyone. Publishing one fills a feed slot
      // with something structurally invisible — found on the first live run,
      // where an untopiced opinion piece ranked second.
      if (classified.value.topics.length === 0) {
        drops.push({
          stage: "classify",
          reason: "unclassified",
          externalId,
          detail: { rejected: classified.value.rejected },
        });
        continue;
      }

      const persisted = await persistCluster(prisma, {
        cluster,
        summary: summarized.value.summary,
        whyItMatters: validated.whyItMatters,
        claims: validated.claims,
        topics: classified.value.topics,
        score: entry.score,
        snapshot: entry.snapshot,
      });

      if (!persisted.ok) {
        drops.push({
          stage: "persist",
          reason: persisted.error.kind,
          externalId,
          detail: persisted.error,
        });
        continue;
      }

      counts.published += 1;
    }

    tally();
    await finish("COMPLETED", counts);

    return ok({ runId: run.id, ...counts });
  } catch (error) {
    // A crash must not leave the run RUNNING forever — the admin view would
    // show a run that never ends, and the next pass could not tell whether one
    // was still in flight.
    const message = error instanceof Error ? error.message : String(error);
    tally();
    await finish("FAILED", counts, message);

    return err({ kind: "crashed", message });
  }
}

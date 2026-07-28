import { type PrismaClient } from "@/generated/prisma/client";
import { type ExtractedClaim } from "@/lib/llm/schemas";
import { type Cluster } from "@/lib/pipeline/clustering";
import { type TopicAssignment } from "@/lib/pipeline/topics";
import { type SignalSnapshot } from "@/lib/ranking/score";
import { err, ok, type Result } from "@/lib/result";
import { isTopicSlug } from "@/lib/topics/taxonomy";

/** Everything the pipeline produces for one cluster, ready to write. */
export interface PersistableCluster {
  cluster: Cluster;
  /** Null when the generated headline failed validation; UI falls back to title. */
  headline: string | null;
  summary: string;
  /** May be empty — a take stripped by claim validation still publishes. */
  whyItMatters: string;
  claims: ExtractedClaim[];
  topics: TopicAssignment[];
  score: number;
  snapshot: SignalSnapshot;
}

export type PersistError =
  { kind: "unknown-topic"; slug: string } | { kind: "write-failed"; message: string };

export interface PersistResult {
  itemId: string;
  /** True when this call created the item rather than updating an existing one. */
  created: boolean;
}

/**
 * Writes one scored cluster to the database.
 *
 * Idempotent by construction: every source is upserted on its natural key
 * `(kind, externalId)`, and the item is keyed to its primary source. Re-running
 * a window therefore updates in place instead of duplicating — the acceptance
 * criterion for the pipeline runner that calls this.
 *
 * The whole write runs in one transaction. A cluster that half-persists — an
 * item with no claims, or claims pointing at a stale take — would put
 * unsupported assertions in front of a reader, which the trust rule forbids.
 */
export async function persistCluster(
  prisma: PrismaClient,
  input: PersistableCluster,
): Promise<Result<PersistResult, PersistError>> {
  const { cluster, headline, summary, whyItMatters, claims, topics, score, snapshot } = input;

  // Validate before opening the transaction: a hallucinated slug should fail
  // the item, not roll back a partial write.
  for (const topic of topics) {
    if (!isTopicSlug(topic.slug)) {
      return err({ kind: "unknown-topic", slug: topic.slug });
    }
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Every source in the cluster is recorded, so the raw payload survives for
      // reprocessing, but only the primary carries the published Item.
      const sourceIds = new Map<string, string>();

      for (const item of cluster.items) {
        const source = await tx.source.upsert({
          where: { kind_externalId: { kind: item.kind, externalId: item.externalId } },
          update: { url: item.sourceUrl, rawPayload: item.raw as object, fetchedAt: new Date() },
          create: {
            kind: item.kind,
            externalId: item.externalId,
            url: item.sourceUrl,
            rawPayload: item.raw as object,
          },
        });
        sourceIds.set(item.externalId, source.id);
      }

      const primarySourceId = sourceIds.get(cluster.primary.externalId)!;
      const existing = await tx.item.findFirst({ where: { sourceId: primarySourceId } });

      const fields = {
        title: cluster.primary.title,
        authors: cluster.primary.authors,
        publishedAt: cluster.primary.publishedAt,
        canonicalUrl: cluster.primary.canonicalUrl,
        headline,
        summary,
        // An empty take is a real outcome of claim validation, not missing data.
        whyItMatters: whyItMatters || null,
        importanceScore: score,
        signalSnapshot: snapshot as unknown as object,
        clusterId: cluster.id,
        published: true,
      };

      const item = existing
        ? await tx.item.update({ where: { id: existing.id }, data: fields })
        : await tx.item.create({
            data: { ...fields, sourceId: primarySourceId, publishedAtFeed: new Date() },
          });

      // Claims and topics are replaced wholesale. A re-run reflects the current
      // take, and a claim left over from a previous take would cite an
      // assertion the item no longer makes.
      await tx.claim.deleteMany({ where: { itemId: item.id } });
      if (claims.length > 0) {
        await tx.claim.createMany({
          data: claims.map((claim) => ({
            itemId: item.id,
            text: claim.text,
            quotedFrom: claim.quotedFrom,
            sourceUrl: cluster.primary.sourceUrl,
          })),
        });
      }

      await tx.itemTopic.deleteMany({ where: { itemId: item.id } });
      for (const topic of topics) {
        const record = await tx.topic.findUnique({ where: { slug: topic.slug } });
        // The taxonomy is seeded; a slug valid in code but absent from the
        // database means the seed did not run, which should fail loudly.
        if (!record) throw new Error(`topic ${topic.slug} is not seeded`);

        await tx.itemTopic.create({
          data: { itemId: item.id, topicId: record.id, confidence: topic.confidence },
        });
      }

      return { itemId: item.id, created: existing === null };
    });

    return ok(result);
  } catch (error) {
    return err({
      kind: "write-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

import { prisma } from "@/lib/db/client";
import { generateDeepDive } from "@/lib/pipeline/deep-dive";
import { resolveQuotableSource } from "@/lib/pipeline/dive-source";
import { err, ok, type Result } from "@/lib/result";

export interface ItemDeepDive {
  content: string;
  generatedAt: Date;
}

export type DeepDiveError = { kind: "not-found" } | { kind: "generation-failed"; message: string };

/**
 * Returns the deep dive for an item, generating it if one is missing.
 *
 * The pipeline pre-generates a dive for every item it publishes, so in the
 * normal case this is a single indexed read. Generation here is the fallback
 * for the items that path could not cover — a dive that failed at publish time
 * (rate limit, or output that never cleared the length floor) leaves the item
 * published with no dive rather than withholding it from the feed.
 *
 * Cached permanently once written: the source does not change, so neither
 * should the explanation.
 */
export async function getOrCreateDeepDive(
  itemId: string,
): Promise<Result<ItemDeepDive, DeepDiveError>> {
  const existing = await prisma.deepDive.findUnique({ where: { itemId } });
  if (existing) {
    return ok({ content: existing.content, generatedAt: existing.generatedAt });
  }

  const item = await prisma.item.findUnique({
    where: { id: itemId },
    include: { source: true },
  });

  if (!item) return err({ kind: "not-found" });

  // The raw payload is retained at ingest precisely so the quotable text can be
  // reconstructed here, rather than re-fetching from the source API.
  const raw = item.source.rawPayload as Record<string, unknown>;
  const baseText =
    (raw.summary as string) ??
    (raw.abstract as string) ??
    (raw.story_text as string) ??
    (raw.text as string) ??
    "";

  const quotableSource = await resolveQuotableSource(baseText, item.canonicalUrl);

  const generated = await generateDeepDive({
    title: item.title,
    headline: item.headline,
    summary: item.summary,
    whyItMatters: item.whyItMatters,
    quotableSource,
    authors: item.authors,
    sourceKinds: [item.source.kind],
  });

  if (!generated.ok) {
    return err({ kind: "generation-failed", message: generated.error.message });
  }

  // Upsert rather than create: two readers can open the same ungenerated item
  // at once, both miss the cache above, and both arrive here. `create` would
  // throw a unique-constraint error on the second, turning a race into a 500.
  // Whichever lands first wins and the other returns the same row — the dives
  // are interchangeable, so there is nothing to reconcile.
  const saved = await prisma.deepDive.upsert({
    where: { itemId },
    create: { itemId, content: generated.value.content },
    update: {},
  });

  return ok({ content: saved.content, generatedAt: saved.generatedAt });
}

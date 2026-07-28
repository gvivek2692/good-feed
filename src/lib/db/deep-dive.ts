import { prisma } from "@/lib/db/client";
import { generateDeepDive } from "@/lib/pipeline/deep-dive";
import { err, ok, type Result } from "@/lib/result";
import { fetchArticleText } from "@/lib/sources/article";

/**
 * Below this much text, an item is treated as having no usable body and the
 * linked page is fetched. Matches the deep-dive generator's own threshold.
 */
const THIN_SOURCE_CHARS = 600;

export interface ItemDeepDive {
  content: string;
  generatedAt: Date;
}

export type DeepDiveError = { kind: "not-found" } | { kind: "generation-failed"; message: string };

/**
 * Returns the deep dive for an item, generating it on first request.
 *
 * Generated on demand rather than at ingest because most items are never
 * opened — pre-generating would spend tokens on every item to serve the few
 * that get read. Cached permanently afterwards: the source does not change, so
 * neither should the explanation.
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
  let quotableSource =
    (raw.summary as string) ??
    (raw.abstract as string) ??
    (raw.story_text as string) ??
    (raw.text as string) ??
    "";

  // A Hacker News link post carries a URL and no body, so the pipeline only
  // ever saw a title — which produced a 40-word deep dive that explained
  // nothing. The linked page is the actual source material. Fetched here rather
  // than at ingest because most items are never opened, and this is the point
  // where the text is genuinely needed.
  if (quotableSource.length < THIN_SOURCE_CHARS && item.canonicalUrl) {
    const article = await fetchArticleText(item.canonicalUrl);
    // A failed fetch degrades to the title-only path rather than failing the
    // page: a thin explainer still beats an error.
    if (article.ok && article.value.length > quotableSource.length) {
      quotableSource = article.value;
    }
  }

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

  const saved = await prisma.deepDive.create({
    data: { itemId, content: generated.value.content },
  });

  return ok({ content: saved.content, generatedAt: saved.generatedAt });
}

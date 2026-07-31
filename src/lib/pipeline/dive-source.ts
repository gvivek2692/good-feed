import { fetchArticleText } from "@/lib/sources/article";

/**
 * Below this much text, an item is treated as having no usable body and the
 * linked page is fetched.
 *
 * Matches the deep-dive generator's own threshold — an HN link post carries a
 * URL and no body, so without this the pipeline sees only a title, which
 * produced a 40-word deep dive that explained nothing.
 */
export const THIN_SOURCE_CHARS = 600;

/**
 * Resolves the text a deep dive may quote from, fetching the linked page when
 * the item's own body is too thin to support one.
 *
 * Shared by the pre-generation path in the pipeline and the on-demand fallback
 * in `getOrCreateDeepDive`, so the two cannot drift on what counts as thin. A
 * failed fetch degrades to whatever text the item already had rather than
 * failing: a thin explainer still beats an error.
 */
export async function resolveQuotableSource(
  baseText: string,
  canonicalUrl: string | null,
): Promise<string> {
  if (baseText.length >= THIN_SOURCE_CHARS || !canonicalUrl) return baseText;

  const article = await fetchArticleText(canonicalUrl);
  return article.ok && article.value.length > baseText.length ? article.value : baseText;
}

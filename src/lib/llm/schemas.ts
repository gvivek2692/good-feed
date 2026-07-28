import { z } from "zod";

/**
 * A single assertion in a take, paired with the source text supporting it.
 *
 * Every comparative or superlative claim ("outperforms X", "first to Y",
 * "supersedes Z") must produce one of these. Task 7 verifies `quotedFrom`
 * actually appears in the source and strips assertions that fail.
 */
export const ClaimSchema = z.object({
  /** The assertion as it appears in the take. */
  text: z.string().min(1).max(300),
  /** Verbatim text from the source. Must be copied, never paraphrased. */
  quotedFrom: z.string().min(1).max(600),
});

export type ExtractedClaim = z.infer<typeof ClaimSchema>;

/** Spec: summaries are capped at 120 words. */
export const SUMMARY_WORD_LIMIT = 120;

/**
 * Headlines are short enough to scan in a feed. Long enough to say something
 * specific — a 5-word headline is almost always vaguer than the paper title it
 * replaced.
 */
export const HEADLINE_WORD_LIMIT = 12;

export const SummarizationSchema = z.object({
  /**
   * A plain-language headline, replacing the paper title in the feed.
   *
   * The highest-risk field in the product after `whyItMatters`: it is the most
   * prominent text on the card and the thing a reader decides on. It is held to
   * the same grounding rule — specific and concrete, never a comparative claim
   * the source does not make.
   */
  headline: z.string().min(1),
  /** What the item is. Plain description, no evaluation. */
  summary: z.string().min(1),
  /**
   * Why it matters — significance, what it builds on, who should care.
   * This is the opinionated part and the highest-risk output in the product.
   */
  whyItMatters: z.string().min(1),
  /** Grounding for every comparative assertion in `whyItMatters`. */
  claims: z.array(ClaimSchema).max(10),
});

export type Summarization = z.infer<typeof SummarizationSchema>;

/**
 * JSON Schema handed to the Gemini API so it constrains generation directly.
 * Kept alongside the Zod schema because they must stay in step — the API
 * shapes the output, Zod verifies what actually arrived.
 */
export const SUMMARIZATION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING" },
    summary: { type: "STRING" },
    whyItMatters: { type: "STRING" },
    claims: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING" },
          quotedFrom: { type: "STRING" },
        },
        required: ["text", "quotedFrom"],
      },
    },
  },
  required: ["headline", "summary", "whyItMatters", "claims"],
};

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

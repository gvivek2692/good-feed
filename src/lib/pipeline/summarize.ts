import { generateStructured, type GenerateImpl, type LlmError } from "@/lib/llm/client";
import { buildSummarizationPrompt } from "@/lib/llm/prompts";
import { SUMMARIZATION_SYSTEM_INSTRUCTION } from "@/lib/llm/prompts";
import {
  HEADLINE_WORD_LIMIT,
  SUMMARIZATION_RESPONSE_SCHEMA,
  SUMMARY_WORD_LIMIT,
  SummarizationSchema,
  wordCount,
  type Summarization,
} from "@/lib/llm/schemas";
import { type Cluster } from "@/lib/pipeline/clustering";
import { err, ok, type Result } from "@/lib/result";

/**
 * A summarized cluster, carrying the source text its claims were quoted from.
 *
 * `quotableSource` is retained deliberately: Task 7 verifies each claim's
 * `quotedFrom` against exactly the text the model was shown, so it must be the
 * same string rather than reconstructed later.
 */
export interface SummarizedCluster {
  clusterId: string;
  headline: string;
  summary: string;
  whyItMatters: string;
  claims: Summarization["claims"];
  quotableSource: string;
}

export interface SummarizeOptions {
  generateImpl?: GenerateImpl;
  maxRetries?: number;
}

/**
 * Assembles the text a cluster's claims may be quoted from.
 *
 * A cluster can hold an arXiv entry and a HuggingFace entry for the same paper;
 * both abstracts are included, deduplicated, since either is legitimate source
 * material for a quote.
 */
export function collectQuotableSource(cluster: Cluster): string {
  const seen = new Set<string>();
  const texts: string[] = [];

  for (const item of cluster.items) {
    const text = item.text?.trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      texts.push(text);
    }
  }

  return texts.join("\n\n");
}

/**
 * Generates a summary, take, and grounded claims for one cluster.
 *
 * Returns an error rather than partial data when the model output is unusable —
 * the pipeline drops the item and records why, instead of publishing half a
 * summary.
 */
export async function summarizeCluster(
  cluster: Cluster,
  options: SummarizeOptions = {},
): Promise<Result<SummarizedCluster, LlmError>> {
  const { primary } = cluster;
  const quotableSource = collectQuotableSource(cluster);

  const prompt = buildSummarizationPrompt({
    title: primary.title,
    sourceText: quotableSource || null,
    authors: primary.authors,
    sourceKinds: [...new Set(cluster.items.map((item) => item.kind))],
  });

  const generated = await generateStructured({
    prompt,
    schema: SummarizationSchema,
    responseSchema: SUMMARIZATION_RESPONSE_SCHEMA,
    systemInstruction: SUMMARIZATION_SYSTEM_INSTRUCTION,
    generateImpl: options.generateImpl,
    maxRetries: options.maxRetries,
  });

  if (!generated.ok) return generated;

  const { headline, summary, whyItMatters, claims } = generated.value;

  // The word limit is a spec requirement, and the API cannot enforce it. A
  // long summary is a real failure, not a formatting quibble — it means the
  // model ignored the instruction and the take is likely padded too.
  if (wordCount(summary) > SUMMARY_WORD_LIMIT) {
    return err({
      kind: "invalidResponse",
      message: `summary was ${wordCount(summary)} words, limit is ${SUMMARY_WORD_LIMIT}`,
    });
  }

  // A headline that runs long is usually the paper title copied back, which
  // defeats the point of generating one.
  if (wordCount(headline) > HEADLINE_WORD_LIMIT) {
    return err({
      kind: "invalidResponse",
      message: `headline was ${wordCount(headline)} words, limit is ${HEADLINE_WORD_LIMIT}`,
    });
  }

  // With no source text there is nothing to quote, so any claim is
  // fabricated by construction.
  if (!quotableSource && claims.length > 0) {
    return err({
      kind: "invalidResponse",
      message: "model produced claims for an item with no quotable source text",
    });
  }

  return ok({
    clusterId: cluster.id,
    headline: headline.trim(),
    summary: summary.trim(),
    whyItMatters: whyItMatters.trim(),
    claims,
    quotableSource,
  });
}

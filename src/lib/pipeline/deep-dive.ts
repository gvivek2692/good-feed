import { generateStructured, type GenerateImpl, type LlmError } from "@/lib/llm/client";
import {
  buildDeepDivePrompt,
  DEEP_DIVE_MAX_WORDS,
  DEEP_DIVE_MIN_WORDS,
  DEEP_DIVE_RESPONSE_SCHEMA,
  DEEP_DIVE_SYSTEM_INSTRUCTION,
  DeepDiveSchema,
} from "@/lib/llm/deep-dive";
import { type ExtractedClaim, wordCount } from "@/lib/llm/schemas";
import { validateClaims } from "@/lib/pipeline/claims";
import { err, ok, type Result } from "@/lib/result";

/**
 * Below this much source text, the length floor is waived. An HN link post with
 * no body cannot support 400 honest words.
 */
const THIN_SOURCE_CHARS = 600;

export interface DeepDiveInput {
  title: string;
  headline: string | null;
  summary: string | null;
  whyItMatters: string | null;
  /** Exactly the text quotes are verified against. */
  quotableSource: string;
  authors: string[];
  sourceKinds: string[];
}

export interface GeneratedDeepDive {
  content: string;
  claims: ExtractedClaim[];
  /** Comparative sentences removed for lacking grounding. */
  strippedCount: number;
  /** True when the piece came in under target despite the source supporting more. */
  belowTargetLength: boolean;
}

export interface DeepDiveOptions {
  generateImpl?: GenerateImpl;
  maxRetries?: number;
}

/**
 * Validates a markdown body paragraph by paragraph.
 *
 * `validateClaims` works on prose, so feeding it whole markdown would let it
 * treat a `## Heading` as part of the following sentence and delete the heading
 * along with a bad claim. Splitting on blank lines keeps structure intact while
 * still stripping at sentence granularity within each block.
 */
function validateMarkdown(
  content: string,
  claims: ExtractedClaim[],
  quotableSource: string,
): { content: string; claims: ExtractedClaim[]; strippedCount: number } {
  const blocks = content.split(/\n{2,}/);
  const kept: string[] = [];
  const keptClaims: ExtractedClaim[] = [];
  let strippedCount = 0;

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Headings and list markers are structure, not assertions.
    if (/^(#{1,6}\s|[-*]\s|\d+\.\s|>)/.test(trimmed)) {
      kept.push(trimmed);
      continue;
    }

    const result = validateClaims({
      whyItMatters: trimmed,
      claims,
      quotableSource,
    });

    strippedCount += result.rejected.length;
    keptClaims.push(...result.claims);

    // A paragraph emptied by validation is dropped rather than left blank.
    if (result.whyItMatters.trim()) kept.push(result.whyItMatters.trim());
  }

  // Same claim can back sentences in several paragraphs; keep one row each.
  const unique = [...new Map(keptClaims.map((claim) => [claim.quotedFrom, claim])).values()];

  return { content: kept.join("\n\n"), claims: unique, strippedCount };
}

/**
 * Generates the long explanation behind a feed item.
 *
 * Bound by the same grounding rule as the take: a longer piece is more room for
 * unsupported assertions, not an exemption from the constraint. Comparative
 * sentences the source does not support are stripped before the piece is
 * cached, so an ungrounded claim never reaches a reader even once.
 */
export async function generateDeepDive(
  input: DeepDiveInput,
  options: DeepDiveOptions = {},
): Promise<Result<GeneratedDeepDive, LlmError>> {
  const basePrompt = buildDeepDivePrompt({
    title: input.title,
    headline: input.headline,
    summary: input.summary,
    whyItMatters: input.whyItMatters,
    sourceText: input.quotableSource || null,
    authors: input.authors,
    sourceKinds: input.sourceKinds,
  });

  const sourceCanSupportLength = input.quotableSource.length >= THIN_SOURCE_CHARS;

  // Retrying with the identical prompt returns the identical short answer, so
  // the second attempt names the miss. Measured: the model reads the length
  // range as advice and lands around 250-320 words; told explicitly that its
  // draft was too short, it expands.
  let generated = await generateStructured({
    prompt: basePrompt,
    schema: DeepDiveSchema,
    responseSchema: DEEP_DIVE_RESPONSE_SCHEMA,
    systemInstruction: DEEP_DIVE_SYSTEM_INSTRUCTION,
    generateImpl: options.generateImpl,
    maxRetries: options.maxRetries,
  });

  if (generated.ok && sourceCanSupportLength) {
    const words = wordCount(generated.value.content);

    if (words < DEEP_DIVE_MIN_WORDS) {
      const retry = await generateStructured({
        prompt:
          `${basePrompt}\n\nA previous draft came in at ${words} words, which is too short — ` +
          `the reader has already read the summary and needs more than that. Write ` +
          `${DEEP_DIVE_MIN_WORDS}-${DEEP_DIVE_MAX_WORDS} words this time. Go deeper into the ` +
          `mechanism and what the results actually mean; do not repeat yourself and do not pad.`,
        schema: DeepDiveSchema,
        responseSchema: DEEP_DIVE_RESPONSE_SCHEMA,
        systemInstruction: DEEP_DIVE_SYSTEM_INSTRUCTION,
        generateImpl: options.generateImpl,
        maxRetries: options.maxRetries,
      });

      // Keep the longer of the two. A retry that came back shorter still beats
      // failing the page outright.
      if (retry.ok && wordCount(retry.value.content) > words) generated = retry;
    }
  }

  if (!generated.ok) return generated;

  const { content, claims } = generated.value;

  // Past the ceiling this stops being an expansion of a feed item and becomes
  // an article, which is a different product.
  if (wordCount(content) > DEEP_DIVE_MAX_WORDS) {
    return err({
      kind: "invalidResponse",
      message: `deep dive was ${wordCount(content)} words, limit is ${DEEP_DIVE_MAX_WORDS}`,
    });
  }

  // Deliberately not an error. The retry above is the real remedy for a short
  // draft; failing here would replace a thin-but-honest page with an error
  // message, which serves the reader worse. `belowTargetLength` lets a caller
  // see it happened without the page breaking.
  const belowTarget = wordCount(content) < DEEP_DIVE_MIN_WORDS;

  if (!input.quotableSource && claims.length > 0) {
    return err({
      kind: "invalidResponse",
      message: "model produced claims for an item with no quotable source text",
    });
  }

  const validated = validateMarkdown(content, claims, input.quotableSource);

  if (!validated.content.trim()) {
    return err({ kind: "invalidResponse", message: "deep dive was empty after validation" });
  }

  return ok({
    content: validated.content,
    claims: validated.claims,
    strippedCount: validated.strippedCount,
    belowTargetLength: belowTarget && sourceCanSupportLength,
  });
}

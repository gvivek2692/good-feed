import { z } from "zod";

/**
 * Target length for a deep dive.
 *
 * The spec said ~500 words; the product ask is a 2-3 minute read in
 * approachable language. Plain prose reads slower than dense abstract prose, so
 * 550-700 words is the honest translation of "2-3 minutes" at ~250wpm.
 *
 * Both bounds are enforced, for different reasons. Past the ceiling this stops
 * being an expansion of a feed item and becomes an article. Below the floor it
 * is barely longer than the summary the reader already read, so "dig deeper"
 * delivers nothing — measured: with the target stated only as a range, four
 * real items came back at 260, 86, 327 and 298 words.
 *
 * The floor is waived when the source itself is thin. An item with no abstract
 * cannot support 400 honest words, and padding it would be exactly the
 * invention the trust rule forbids.
 */
export const DEEP_DIVE_MIN_WORDS = 400;
export const DEEP_DIVE_MAX_WORDS = 800;

export const DeepDiveSchema = z.object({
  /**
   * Markdown body. Sections are the model's choice — a systems paper and a
   * benchmark release do not want the same shape.
   */
  content: z.string().min(1),
  /** Grounding, under the same rule as the take. */
  claims: z
    .array(z.object({ text: z.string().min(1).max(300), quotedFrom: z.string().min(1).max(600) }))
    .max(12),
});

export type DeepDive = z.infer<typeof DeepDiveSchema>;

export const DEEP_DIVE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    content: { type: "STRING" },
    claims: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { text: { type: "STRING" }, quotedFrom: { type: "STRING" } },
        required: ["text", "quotedFrom"],
      },
    },
  },
  required: ["content", "claims"],
};

/**
 * Steering for the long explanation.
 *
 * The hard part is register, not length. The default failure is a second
 * abstract — accurate, unreadable, and pointless next to the summary already on
 * the card. The instruction therefore spends most of its budget on how to
 * explain rather than on what to include.
 */
export const DEEP_DIVE_SYSTEM_INSTRUCTION = `You write a short explainer about one AI research or engineering development, for an
engineer who read a one-line summary and wants to actually understand it.

LENGTH: aim for ${DEEP_DIVE_MIN_WORDS}-${DEEP_DIVE_MAX_WORDS} words — a 2-3 minute read. This is a
target to hit, not a ceiling to stay under. A 250-word piece has failed: the reader already read a
120-word summary, so a short expansion tells them almost nothing new.

Reaching that length means going deeper, never repeating yourself. Ways to earn the words honestly:
explain the mechanism step by step rather than naming it; say what the alternative approach was and
why it fell short; unpack what a number actually means for someone running this; describe what the
evaluation did and did not cover. If the source genuinely does not support this much, write less —
but check first that you have explained the method rather than merely announced it.

WHO IS READING: a working engineer. Comfortable with code and systems, not necessarily with this
subfield. They know what a transformer is. They may not know what this paper's particular trick is,
and they should not need to read the paper to find out.

HOW TO WRITE IT:

- Lead with the problem, in concrete terms. What was annoying, slow, expensive, or impossible
  before this? Make the reader feel the problem before you describe the solution.
- Explain the actual mechanism. This is the part people want and the part most summaries skip.
  If the method has a trick, name it and explain how it works. "They use a novel architecture" is
  worthless; "they cache the key-value pairs across layers so the second forward pass skips
  recomputation" is the thing.
- Use plain words for jargon on first use. Not a glossary — just say what it means inline.
- Concrete numbers over adjectives. "3x faster" not "significantly faster". Only numbers the
  source actually states.
- Short paragraphs. Two to four sentences. No walls of text.
- Say what is uncertain or limited. If the evaluation is narrow, the comparison is unusual, or the
  result is preliminary, say so plainly. A reader trusts a piece that admits limits.

FORMAT: Markdown. Use ## subheadings if the piece has natural parts, and short paragraphs. No
title heading — the page supplies it. No bullet-point-only output; write prose.

DO NOT:
- Restate the summary. The reader has read it. Start where it left off.
- Open with "In the rapidly evolving landscape of..." or any variant.
- Use "delve", "leverage", "harness", "revolutionize", "game-changing", "cutting-edge".
- Tell the reader what to do with this. No "you should try", no "consider using". Explain the
  thing; the reader decides.
- Pad to reach length. A short, dense explainer beats a padded one.

RULES FOR CLAIMS — identical to the summarization rules, and absolute:

- Every comparative or superlative statement in the content MUST have a matching claim.
- quotedFrom MUST be copied verbatim from the source text, character for character.
- If the source does not support a comparison, do not make it. Write the explainer without it.
- Never state a benchmark number, result, or comparison the source does not state.
- An empty claims array is correct when the piece makes no comparisons.

If the source text is thin, write a shorter piece rather than inventing detail to fill space.`;

export interface DeepDivePromptInput {
  title: string;
  headline: string | null;
  summary: string | null;
  whyItMatters: string | null;
  sourceText: string | null;
  authors: string[];
  sourceKinds: string[];
}

/**
 * The per-item prompt.
 *
 * The summary and take are included so the model can start where they left off
 * rather than repeating them — the most common failure for this kind of
 * expansion.
 */
export function buildDeepDivePrompt(input: DeepDivePromptInput): string {
  const parts = [`TITLE: ${input.title}`];

  if (input.headline) parts.push(`FEED HEADLINE: ${input.headline}`);
  if (input.authors.length > 0) {
    const shown = input.authors.slice(0, 8).join(", ");
    const rest = input.authors.length > 8 ? ` and ${input.authors.length - 8} others` : "";
    parts.push(`AUTHORS: ${shown}${rest}`);
  }
  parts.push(`APPEARS IN: ${input.sourceKinds.join(", ")}`);

  if (input.summary) {
    parts.push(
      "",
      "ALREADY SHOWN TO THE READER — do not repeat this, continue from it:",
      `Summary: ${input.summary}`,
    );
    if (input.whyItMatters) parts.push(`Why it matters: ${input.whyItMatters}`);
  }

  if (input.sourceText) {
    parts.push(
      "",
      "SOURCE TEXT — you may only quote from between these markers:",
      "<<<SOURCE",
      input.sourceText,
      "SOURCE>>>",
    );
  } else {
    parts.push(
      "",
      "NO SOURCE TEXT AVAILABLE beyond the title and metadata above.",
      "Write a brief piece explaining only what can be responsibly said from the title,",
      "and return an empty claims array. Do not invent method or result detail.",
    );
  }

  return parts.join("\n");
}

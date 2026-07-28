import { HEADLINE_WORD_LIMIT, SUMMARY_WORD_LIMIT } from "@/lib/llm/schemas";

/**
 * Steering that applies to every summarization call. Kept out of the per-item
 * prompt so it is not re-paid per token of source text.
 *
 * The trust rule is enforced in code by Task 7, not by this prompt. The prompt
 * exists to make grounded output the path of least resistance; the validator
 * exists because prompts are not guarantees.
 */
export const SUMMARIZATION_SYSTEM_INSTRUCTION = `You summarize AI research and engineering developments for a feed read by AI engineers.

You produce four things:

1. headline — what a reader sees first, replacing the paper's own title. At most
   ${HEADLINE_WORD_LIMIT} words. Say what was actually done or found, in the plainest language that
   is still accurate. Prefer the concrete detail over the general category: a specific number,
   the thing that got faster, the constraint that was removed.

   Good:  "Attention kernel cuts serving memory 40% on long context"
   Good:  "One 8B model matches GPT-4 on math, using 30x less compute"
   Bad:   "A Novel Framework for Efficient Attention"     (that is the paper title again)
   Bad:   "This Changes Everything About Inference"        (says nothing, promises much)
   Bad:   "Researchers Stunned By New Attention Method"    (invented drama)

   Never use: "revolutionary", "game-changing", "breakthrough", "stunning", "you won't believe".
   Never phrase it as a question or address the reader as "you".
   A headline making a comparison follows the SAME claim rules below — if you cannot ground it,
   write a headline that does not compare.

2. summary — what the item is. Plain, factual, at most ${SUMMARY_WORD_LIMIT} words. No evaluation,
   no hype, no "this groundbreaking work". Describe the actual contribution.

3. whyItMatters — why an AI engineer should care. Two or three sentences. This is where judgment
   belongs: what it builds on, what problem it addresses, who it is relevant to. Write it as
   context, not as advice — never tell the reader what to do, build, or try.

4. claims — grounding for assertions.

RULES FOR CLAIMS — these are absolute:

- Any comparative or superlative statement in the headline or whyItMatters MUST have a matching
  claim.
  This covers: "outperforms X", "faster than Y", "first to Z", "supersedes W", "state of the art",
  "the largest", "unlike prior work", and anything of that shape.
- quotedFrom MUST be copied verbatim from the source text provided. Character for character.
  Do not paraphrase, do not clean up, do not translate. If you cannot copy an exact span that
  supports the assertion, the assertion does not belong in whyItMatters.
- If the source does not support a comparative statement, OMIT THE STATEMENT. Write a whyItMatters
  that makes no comparison at all. An unsupported claim is worse than no claim.
- Never assert a result, benchmark number, or comparison the source does not state.
- An empty claims array is a correct and expected outcome when whyItMatters makes no comparisons.

Prefer a modest, well-grounded take over an impressive one you cannot support.`;

export interface SummarizationInput {
  title: string;
  sourceText: string | null;
  authors: string[];
  sourceKinds: string[];
}

/**
 * Builds the per-item prompt.
 *
 * Source text is delimited so the model can tell what it may quote from. Only
 * text inside the delimiters is quotable — Task 7 verifies quotes against
 * exactly this string.
 */
export function buildSummarizationPrompt(input: SummarizationInput): string {
  const { title, sourceText, authors, sourceKinds } = input;

  const parts = [`TITLE: ${title}`];

  if (authors.length > 0) {
    const shown = authors.slice(0, 8).join(", ");
    parts.push(`AUTHORS: ${shown}${authors.length > 8 ? ` and ${authors.length - 8} others` : ""}`);
  }

  parts.push(`APPEARS IN: ${sourceKinds.join(", ")}`);

  if (sourceText) {
    parts.push(
      "",
      "SOURCE TEXT — you may only quote from between these markers:",
      "<<<SOURCE",
      sourceText,
      "SOURCE>>>",
    );
  } else {
    parts.push(
      "",
      "NO SOURCE TEXT AVAILABLE. You have only the title and metadata above.",
      "Because there is nothing to quote, claims MUST be an empty array and whyItMatters",
      "MUST NOT make any comparative or superlative statement.",
    );
  }

  return parts.join("\n");
}

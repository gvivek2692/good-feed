/** @vitest-environment node */
import { describe, expect, it } from "vitest";

import {
  findComparativeSentences,
  isQuoteGrounded,
  validateClaims,
  type ClaimValidation,
} from "@/lib/pipeline/claims";

const SOURCE =
  "We propose FlashLite, which reduces memory use by 40% versus FlashAttention-2. " +
  "Training converges in 3 hours on a single node.";

function validation(overrides: Partial<Parameters<typeof validateClaims>[0]> = {}): ClaimValidation {
  return validateClaims({
    whyItMatters: "It cuts memory use by 40% versus FlashAttention-2, which matters at long context.",
    claims: [
      {
        text: "cuts memory use by 40% versus FlashAttention-2",
        quotedFrom: "reduces memory use by 40% versus FlashAttention-2",
      },
    ],
    quotableSource: SOURCE,
    ...overrides,
  });
}

describe("isQuoteGrounded", () => {
  it("accepts a quote copied verbatim", () => {
    expect(isQuoteGrounded("reduces memory use by 40%", SOURCE)).toBe(true);
  });

  it("rejects a quote that does not appear in the source", () => {
    expect(isQuoteGrounded("outperforms every prior method", SOURCE)).toBe(false);
  });

  /**
   * arXiv abstracts arrive with hard line wraps. A quote spanning a wrap has a
   * space where the source has a newline; rejecting it would strip a claim that
   * is genuinely grounded.
   */
  it("matches across a line break in the source", () => {
    const wrapped = "We propose FlashLite, which reduces memory\nuse by 40% versus FlashAttention-2.";
    expect(isQuoteGrounded("reduces memory use by 40%", wrapped)).toBe(true);
  });

  it("matches when the model collapses runs of whitespace", () => {
    expect(isQuoteGrounded("Training  converges   in 3 hours", SOURCE)).toBe(true);
  });

  /**
   * Deliberately strict. Loosening past whitespace starts admitting paraphrase,
   * which is the thing the trust rule exists to prevent.
   */
  it("rejects a paraphrase that changes wording", () => {
    expect(isQuoteGrounded("lowers memory use by 40%", SOURCE)).toBe(false);
  });

  it("rejects a quote whose numbers were altered", () => {
    expect(isQuoteGrounded("reduces memory use by 60% versus FlashAttention-2", SOURCE)).toBe(false);
  });

  /**
   * Found by running real arXiv abstracts through the validator. Abstracts are
   * raw LaTeX, so the source holds `72.5\%` while the model quotes the rendered
   * `72.5%`. Without unwrapping the escape, a character-perfect quote of a
   * genuine result gets stripped.
   */
  it("matches a quote against a LaTeX-escaped percent sign in the source", () => {
    const latex = "Relative to Vanilla Claude Code, it reduces measured monetary cost by 72.5\\%.";
    expect(isQuoteGrounded("reduces measured monetary cost by 72.5%", latex)).toBe(true);
  });

  it("matches across LaTeX formatting commands in the source", () => {
    const latex = "\\textsc{DataFlow-Harness} achieves a 93.3\\% observed end-to-end pass rate.";
    expect(isQuoteGrounded("DataFlow-Harness achieves a 93.3% observed end-to-end pass rate", latex)).toBe(
      true,
    );
  });

  it("still rejects a wording change in LaTeX-escaped source", () => {
    const latex = "it reduces measured monetary cost by 72.5\\%.";
    expect(isQuoteGrounded("reduces measured monetary cost by 80%", latex)).toBe(false);
  });

  it("rejects an empty or whitespace-only quote", () => {
    expect(isQuoteGrounded("   ", SOURCE)).toBe(false);
  });

  it("rejects any quote when there is no source text", () => {
    expect(isQuoteGrounded("anything at all", "")).toBe(false);
  });
});

describe("findComparativeSentences", () => {
  it("flags an explicit comparison", () => {
    expect(findComparativeSentences("It outperforms FlashAttention-2 on long context.")).toHaveLength(
      1,
    );
  });

  it("flags superlatives", () => {
    expect(findComparativeSentences("This is the first method to do so.")).toHaveLength(1);
  });

  it("flags state-of-the-art phrasing", () => {
    expect(findComparativeSentences("It reaches state of the art on GSM8K.")).toHaveLength(1);
  });

  it("does not flag a purely descriptive take", () => {
    expect(
      findComparativeSentences(
        "This is relevant to engineers working on long-context inference pipelines.",
      ),
    ).toHaveLength(0);
  });

  it("splits on sentence boundaries so one bad sentence does not condemn the take", () => {
    const sentences = findComparativeSentences(
      "This targets long-context inference. It outperforms FlashAttention-2. Useful for serving.",
    );

    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toContain("outperforms");
  });

  it("does not treat a decimal point as a sentence boundary", () => {
    const sentences = findComparativeSentences("It beats the baseline by 3.5 points on MMLU.");
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toContain("3.5");
  });
});

describe("validateClaims", () => {
  it("passes a take through unmodified when every claim verifies", () => {
    const result = validation();

    expect(result.claims).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.whyItMatters).toContain("cuts memory use by 40%");
    expect(result.modified).toBe(false);
  });

  /**
   * The acceptance criterion, and the reason this task exists. The assertion
   * itself must leave the take — dropping only the Claim row would publish the
   * same unsupported statement with its citation removed, which is worse.
   */
  it("strips an assertion whose quote is not in the source", () => {
    const result = validateClaims({
      whyItMatters:
        "This targets long-context inference. It outperforms every prior method on GSM8K.",
      claims: [
        {
          text: "outperforms every prior method",
          quotedFrom: "outperforms every prior method on all benchmarks",
        },
      ],
      quotableSource: SOURCE,
    });

    expect(result.whyItMatters).not.toContain("outperforms");
    expect(result.whyItMatters).toContain("long-context inference");
    expect(result.claims).toHaveLength(0);
    expect(result.modified).toBe(true);
  });

  it("strips a comparative sentence that has no claim backing it at all", () => {
    const result = validateClaims({
      whyItMatters: "It matters for serving. It is faster than FlashAttention-2.",
      claims: [],
      quotableSource: SOURCE,
    });

    expect(result.whyItMatters).toBe("It matters for serving.");
    expect(result.modified).toBe(true);
  });

  it("records a reason for every rejection, for the run log", () => {
    const result = validateClaims({
      whyItMatters: "It outperforms every prior method.",
      claims: [
        { text: "outperforms every prior method", quotedFrom: "not in the source at all" },
      ],
      quotableSource: SOURCE,
    });

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("quote-not-in-source");
    expect(result.rejected[0].quotedFrom).toBe("not in the source at all");
  });

  it("distinguishes an unbacked sentence from a failed quote in the rejection reason", () => {
    const result = validateClaims({
      whyItMatters: "It is faster than every alternative.",
      claims: [],
      quotableSource: SOURCE,
    });

    expect(result.rejected[0].reason).toBe("no-claim-for-assertion");
  });

  /**
   * Spec: "if that empties the take, the item publishes with summary only."
   * An empty take must not block publication.
   */
  it("yields an empty take rather than failing when every sentence is stripped", () => {
    const result = validateClaims({
      whyItMatters: "It outperforms everything. It is the first of its kind.",
      claims: [],
      quotableSource: SOURCE,
    });

    expect(result.whyItMatters).toBe("");
    expect(result.rejected).toHaveLength(2);
  });

  it("keeps a grounded comparison while stripping an ungrounded one in the same take", () => {
    const result = validateClaims({
      whyItMatters:
        "It reduces memory use by 40% versus FlashAttention-2. It also outperforms every published method.",
      claims: [
        {
          text: "reduces memory use by 40% versus FlashAttention-2",
          quotedFrom: "reduces memory use by 40% versus FlashAttention-2",
        },
      ],
      quotableSource: SOURCE,
    });

    expect(result.whyItMatters).toContain("40% versus FlashAttention-2");
    expect(result.whyItMatters).not.toContain("outperforms");
    expect(result.claims).toHaveLength(1);
  });

  /**
   * A claim that verifies but corresponds to no sentence in the take is not a
   * trust failure — but persisting it would render a citation on a take that
   * does not make the assertion.
   */
  it("drops a verified claim that no longer matches any sentence in the take", () => {
    const result = validateClaims({
      whyItMatters: "This is relevant to long-context inference work.",
      claims: [
        {
          text: "reduces memory use by 40% versus FlashAttention-2",
          quotedFrom: "reduces memory use by 40% versus FlashAttention-2",
        },
      ],
      quotableSource: SOURCE,
    });

    expect(result.claims).toHaveLength(0);
    expect(result.whyItMatters).toBe("This is relevant to long-context inference work.");
  });

  it("leaves a descriptive take with no claims completely alone", () => {
    const result = validateClaims({
      whyItMatters: "Relevant to engineers building long-context inference pipelines.",
      claims: [],
      quotableSource: SOURCE,
    });

    expect(result.modified).toBe(false);
    expect(result.whyItMatters).toBe(
      "Relevant to engineers building long-context inference pipelines.",
    );
  });

  it("strips every comparative sentence when there is no source text to quote", () => {
    const result = validateClaims({
      whyItMatters: "A link post. It outperforms the prior state of the art.",
      claims: [],
      quotableSource: "",
    });

    expect(result.whyItMatters).toBe("A link post.");
  });
});

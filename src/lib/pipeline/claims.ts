import { type ExtractedClaim } from "@/lib/llm/schemas";

/**
 * Why a comparative assertion was removed from a take. Recorded per rejection
 * so run logs say what was stripped and why, not just that something was.
 */
export type RejectionReason = "quote-not-in-source" | "no-claim-for-assertion";

export interface RejectedAssertion {
  /** The sentence removed from the take. */
  sentence: string;
  reason: RejectionReason;
  /** The quote that failed verification, when there was one to fail. */
  quotedFrom?: string;
}

export interface ClaimValidation {
  whyItMatters: string;
  claims: ExtractedClaim[];
  rejected: RejectedAssertion[];
  /** True when anything was removed — the signal worth logging. */
  modified: boolean;
}

export interface ValidateClaimsInput {
  whyItMatters: string;
  claims: ExtractedClaim[];
  /** Exactly the text the model was shown, from `SummarizedCluster`. */
  quotableSource: string;
}

/**
 * Words and phrases that make a sentence a comparative or superlative claim.
 *
 * Deliberately over-inclusive: a false positive costs a grounded sentence that
 * the model can support with a quote, while a false negative lets an
 * unsupported assertion reach the reader. The spec's trust rule makes that
 * trade one-sided.
 */
const COMPARATIVE_PATTERNS: readonly RegExp[] = [
  /\b(?:out(?:performs?|paces?|scores?)|beats?|surpasses?|exceeds?|supersedes?)\b/i,
  /\b(?:faster|slower|cheaper|smaller|larger|better|worse|stronger|weaker|higher|lower)\s+than\b/i,
  /\b(?:more|less|fewer)\s+\w+\s+than\b/i,
  /\bcompared\s+(?:to|with)\b/i,
  /\b(?:versus|vs\.?)\b/i,
  /\bstate[- ]of[- ]the[- ]art\b/i,
  /\b(?:the\s+first|first\s+(?:to|method|model|system|approach|work))\b/i,
  /\bthe\s+(?:largest|smallest|fastest|best|only|highest|lowest)\b/i,
  /\b(?:unlike|in\s+contrast\s+to)\s+(?:prior|previous|existing|earlier)\b/i,
  /\b(?:obsoletes?|replaces?|renders?\s+obsolete)\b/i,
  /\bnew\s+(?:record|benchmark)\b/i,
];

/**
 * Puts a quote and its source into the same encoding so they can be compared.
 *
 * Whitespace is collapsed because arXiv abstracts arrive hard-wrapped, and
 * LaTeX escaping is unwrapped because those abstracts are raw LaTeX: the source
 * holds `72.5\%` and `\textsc{Name}` where the model quotes the rendered
 * `72.5%` and `Name`. Both are encoding differences, not wording differences —
 * a character-perfect quote fails without this, which is a worse outcome than
 * the strictness buys.
 */
function normalize(text: string): string {
  return text
    .replace(/\\(?:textsc|textbf|textit|emph|texttt|mathrm)\{([^}]*)\}/g, "$1")
    .replace(/\\([%$&#_{}])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a quote genuinely appears in the source.
 *
 * Only whitespace is normalized. Case and punctuation are left strict on
 * purpose: "verbatim" is the contract, and loosening further starts admitting
 * paraphrase, which is exactly what the trust rule exists to prevent.
 */
export function isQuoteGrounded(quotedFrom: string, quotableSource: string): boolean {
  const quote = normalize(quotedFrom);
  if (!quote) return false;

  return normalize(quotableSource).includes(quote);
}

/**
 * Splits a take into sentences without breaking on decimal points, which
 * appear constantly in benchmark numbers ("3.5 points on MMLU").
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Returns the sentences of a take that make a comparative or superlative claim. */
export function findComparativeSentences(whyItMatters: string): string[] {
  return splitSentences(whyItMatters).filter((sentence) =>
    COMPARATIVE_PATTERNS.some((pattern) => pattern.test(sentence)),
  );
}

/**
 * Whether a claim is the one backing a given sentence.
 *
 * The model writes `claim.text` as its own rendering of the assertion, so it
 * rarely matches the sentence character for character. Overlap of significant
 * words is the workable test.
 */
function claimSupportsSentence(claim: ExtractedClaim, sentence: string): boolean {
  const words = (text: string): Set<string> =>
    new Set(
      normalize(text)
        .toLowerCase()
        .replace(/[^\w\s%.-]/g, "")
        .split(" ")
        .filter((word) => word.length > 3),
    );

  const claimWords = words(claim.text);
  if (claimWords.size === 0) return false;

  const sentenceWords = words(sentence);
  let shared = 0;
  for (const word of claimWords) {
    if (sentenceWords.has(word)) shared += 1;
  }

  return shared / claimWords.size >= 0.5;
}

/**
 * Whether a generated headline is safe to show.
 *
 * A headline is a single sentence in the most prominent position on the card,
 * so the take's remedy — delete the offending sentence — is not available:
 * that would leave no headline at all. Instead an ungrounded comparative
 * headline is rejected outright and the caller falls back to the source's own
 * title, which is dull but always true.
 */
export function isHeadlineGrounded(
  headline: string,
  claims: readonly ExtractedClaim[],
  quotableSource: string,
): boolean {
  const isComparative = COMPARATIVE_PATTERNS.some((pattern) => pattern.test(headline));
  if (!isComparative) return true;

  return claims.some(
    (claim) =>
      isQuoteGrounded(claim.quotedFrom, quotableSource) && claimSupportsSentence(claim, headline),
  );
}

/**
 * Strips unsupported assertions from a take before persistence.
 *
 * A comparative sentence survives only if some claim both (a) corresponds to it
 * and (b) quotes text that actually appears in the source. Everything else is
 * removed from the take itself — dropping only the `Claim` row would publish the
 * same unsupported assertion with its citation missing, which is worse than
 * publishing nothing.
 *
 * Emptying the take is a valid outcome: per the spec, the item then publishes
 * with its summary only.
 */
export function validateClaims(input: ValidateClaimsInput): ClaimValidation {
  const { whyItMatters, claims, quotableSource } = input;

  const grounded = claims.filter((claim) => isQuoteGrounded(claim.quotedFrom, quotableSource));
  const rejected: RejectedAssertion[] = [];
  const keptSentences: string[] = [];
  const usedClaims = new Set<ExtractedClaim>();

  for (const sentence of splitSentences(whyItMatters)) {
    const isComparative = COMPARATIVE_PATTERNS.some((pattern) => pattern.test(sentence));
    if (!isComparative) {
      keptSentences.push(sentence);
      continue;
    }

    const support = grounded.find((claim) => claimSupportsSentence(claim, sentence));
    if (support) {
      usedClaims.add(support);
      keptSentences.push(sentence);
      continue;
    }

    // Distinguish "the model tried to ground this and the quote was fake" from
    // "the model asserted this with nothing behind it" — different failures,
    // and the run log should tell them apart.
    const attempted = claims.find((claim) => claimSupportsSentence(claim, sentence));
    rejected.push(
      attempted
        ? { sentence, reason: "quote-not-in-source", quotedFrom: attempted.quotedFrom }
        : { sentence, reason: "no-claim-for-assertion" },
    );
  }

  // A claim matching no surviving sentence would render as a citation on an
  // assertion the take no longer makes.
  const keptClaims = grounded.filter((claim) => usedClaims.has(claim));

  return {
    whyItMatters: keptSentences.join(" "),
    claims: keptClaims,
    rejected,
    modified: rejected.length > 0 || keptClaims.length !== claims.length,
  };
}

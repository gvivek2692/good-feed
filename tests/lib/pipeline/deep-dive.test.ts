/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

import { type GenerateImpl } from "@/lib/llm/client";
import {
  buildDeepDivePrompt,
  DEEP_DIVE_MAX_WORDS,
  DEEP_DIVE_SYSTEM_INSTRUCTION,
} from "@/lib/llm/deep-dive";
import { generateDeepDive, type DeepDiveInput } from "@/lib/pipeline/deep-dive";

const SOURCE =
  "We propose FlashLite, which reduces memory use by 40% versus FlashAttention-2. " +
  "It caches key-value pairs across layers so the second forward pass skips recomputation.";

function input(overrides: Partial<DeepDiveInput> = {}): DeepDiveInput {
  return {
    title: "FlashLite: Efficient Attention",
    headline: "Attention kernel cuts serving memory 40%",
    summary: "A kernel that reduces attention memory during serving.",
    whyItMatters: "It matters for long-context inference.",
    quotableSource: SOURCE,
    authors: ["Ada Lovelace"],
    sourceKinds: ["ARXIV"],
    ...overrides,
  };
}

function respondWith(payload: unknown): GenerateImpl {
  return async () => ({ text: JSON.stringify(payload) });
}

const body = Array.from({ length: 450 }, () => "word").join(" ");

const goodResponse = {
  // The body must actually contain the sentence its claim backs — a claim
  // matching no surviving sentence is dropped, correctly.
  content: `## The problem\n\nIt reduces memory use by 40% versus FlashAttention-2.\n\n${body}`,
  claims: [
    {
      text: "reduces memory use by 40% versus FlashAttention-2",
      quotedFrom: "reduces memory use by 40% versus FlashAttention-2",
    },
  ],
};

describe("buildDeepDivePrompt", () => {
  it("includes the summary so the model continues rather than repeats it", () => {
    const prompt = buildDeepDivePrompt({
      title: "T",
      headline: null,
      summary: "The summary already shown.",
      whyItMatters: "The take already shown.",
      sourceText: "Text.",
      authors: [],
      sourceKinds: ["ARXIV"],
    });

    expect(prompt).toContain("do not repeat this");
    expect(prompt).toContain("The summary already shown.");
  });

  it("delimits quotable source text", () => {
    const prompt = buildDeepDivePrompt({
      title: "T",
      headline: null,
      summary: null,
      whyItMatters: null,
      sourceText: "The abstract.",
      authors: [],
      sourceKinds: ["ARXIV"],
    });

    expect(prompt).toContain("<<<SOURCE");
    expect(prompt).toContain("SOURCE>>>");
  });

  it("forbids inventing detail when there is no source text", () => {
    const prompt = buildDeepDivePrompt({
      title: "T",
      headline: null,
      summary: null,
      whyItMatters: null,
      sourceText: null,
      authors: [],
      sourceKinds: ["HACKERNEWS"],
    });

    expect(prompt).toContain("Do not invent method or result detail");
  });
});

describe("DEEP_DIVE_SYSTEM_INSTRUCTION", () => {
  it("targets a 2-3 minute read, not an article", () => {
    expect(DEEP_DIVE_SYSTEM_INSTRUCTION).toContain("2-3 minute read");
  });

  it("keeps the piece explanatory rather than advisory, per the spec's scope boundary", () => {
    expect(DEEP_DIVE_SYSTEM_INSTRUCTION).toContain('No "you should try"');
  });

  it("carries the same absolute claim rules as summarization", () => {
    expect(DEEP_DIVE_SYSTEM_INSTRUCTION).toContain("verbatim");
    expect(DEEP_DIVE_SYSTEM_INSTRUCTION).toContain("MUST have a matching claim");
  });
});

describe("generateDeepDive", () => {
  it("returns content and grounded claims for a well-formed response", async () => {
    const result = await generateDeepDive(input(), { generateImpl: respondWith(goodResponse) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain("## The problem");
    expect(result.value.claims).toHaveLength(1);
  });

  it("rejects a piece that runs past the length ceiling", async () => {
    vi.useFakeTimers();
    const promise = generateDeepDive(input(), {
      maxRetries: 0,
      generateImpl: respondWith({
        content: Array.from({ length: DEEP_DIVE_MAX_WORDS + 50 }, () => "word").join(" "),
        claims: [],
      }),
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("words");
  });

  /**
   * The trust rule applies here as much as to the take — a longer piece is more
   * room for unsupported assertions, not less.
   */
  it("strips a comparative sentence the source does not support", async () => {
    const result = await generateDeepDive(input(), {
      generateImpl: respondWith({
        content: `## How it works\n\nIt caches key-value pairs across layers. It outperforms every published method.\n\n${body}`,
        claims: [],
      }),
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.content).not.toContain("outperforms");
    expect(result.value.content).toContain("caches key-value pairs");
    expect(result.value.strippedCount).toBe(1);
  });

  it("keeps a comparison that its claim genuinely grounds", async () => {
    const result = await generateDeepDive(input(), {
      generateImpl: respondWith({
        content: `## Result\n\nIt reduces memory use by 40% versus FlashAttention-2.\n\n${body}`,
        claims: [
          {
            text: "reduces memory use by 40% versus FlashAttention-2",
            quotedFrom: "reduces memory use by 40% versus FlashAttention-2",
          },
        ],
      }),
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.content).toContain("40% versus FlashAttention-2");
    expect(result.value.strippedCount).toBe(0);
  });

  it("preserves markdown headings while stripping a bad sentence beneath one", async () => {
    const result = await generateDeepDive(input(), {
      generateImpl: respondWith({
        content: `## The problem\n\nMemory is the bottleneck.\n\n## The trick\n\nIt beats all prior work.\n\n${body}`,
        claims: [],
      }),
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.content).toContain("## The problem");
    expect(result.value.content).toContain("## The trick");
    expect(result.value.content).not.toContain("beats all prior work");
  });

  /**
   * Measured: with the length range stated only in the prompt, four real items
   * came back at 260, 86, 327 and 298 words. A piece barely longer than the
   * summary makes "dig deeper" pointless, so the floor is enforced in code.
   */
  it("retries with the miss named when a draft comes in short", async () => {
    const prompts: string[] = [];
    const generateImpl: GenerateImpl = async (args) => {
      prompts.push(args.contents);
      const short = Array.from({ length: 200 }, () => "word").join(" ");
      const long = Array.from({ length: 450 }, () => "word").join(" ");
      return { text: JSON.stringify({ content: prompts.length === 1 ? short : long, claims: [] }) };
    };

    const result = await generateDeepDive(input({ quotableSource: SOURCE.repeat(12) }), {
      generateImpl,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("too short");
    if (!result.ok) throw new Error("expected success");
    expect(result.value.belowTargetLength).toBe(false);
  });

  /**
   * A short page still beats an error page. The retry is the remedy; failing
   * outright would replace thin-but-honest content with nothing.
   */
  it("publishes a short piece rather than failing when the retry also comes back short", async () => {
    const result = await generateDeepDive(input({ quotableSource: SOURCE.repeat(12) }), {
      generateImpl: respondWith({
        content: Array.from({ length: 200 }, () => "word").join(" "),
        claims: [],
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.belowTargetLength).toBe(true);
  });

  /**
   * The floor is waived for a thin source: an HN link post with no abstract
   * cannot support 400 honest words, and padding it would be the invention the
   * trust rule forbids.
   */
  it("accepts a short piece when the source itself is thin", async () => {
    const result = await generateDeepDive(input({ quotableSource: "A one-line note." }), {
      generateImpl: respondWith({
        content: Array.from({ length: 90 }, () => "word").join(" "),
        claims: [],
      }),
    });

    expect(result.ok).toBe(true);
  });

  it("returns an error rather than partial content on a malformed response", async () => {
    vi.useFakeTimers();
    const promise = generateDeepDive(input(), {
      maxRetries: 0,
      generateImpl: respondWith({ notContent: true }),
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalidResponse");
  });

  it("rejects claims when the item had no quotable source", async () => {
    vi.useFakeTimers();
    const promise = generateDeepDive(input({ quotableSource: "" }), {
      maxRetries: 0,
      generateImpl: respondWith({
        content: `## Overview\n\n${body}`,
        claims: [{ text: "fastest yet", quotedFrom: "fastest yet" }],
      }),
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
  });
});

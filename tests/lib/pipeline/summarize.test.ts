/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

import { type GenerateImpl } from "@/lib/llm/client";
import { buildSummarizationPrompt, SUMMARIZATION_SYSTEM_INSTRUCTION } from "@/lib/llm/prompts";
import { SUMMARY_WORD_LIMIT } from "@/lib/llm/schemas";
import { type Cluster } from "@/lib/pipeline/clustering";
import { collectQuotableSource, summarizeCluster } from "@/lib/pipeline/summarize";
import { type NormalizedItem } from "@/lib/sources/types";

function item(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    externalId: "2607.22534v1",
    kind: "ARXIV",
    title: "Efficient Attention for Long Sequences",
    authors: ["Ada Lovelace"],
    publishedAt: new Date("2026-07-20T00:00:00Z"),
    canonicalUrl: "https://arxiv.org/abs/2607.22534",
    sourceUrl: "https://arxiv.org/abs/2607.22534",
    text: "We propose FlashLite, which reduces memory use by 40% versus FlashAttention-2.",
    arxivId: "2607.22534",
    signals: {},
    raw: {},
    ...overrides,
  };
}

function cluster(items: NormalizedItem[] = [item()]): Cluster {
  return {
    id: `arxiv:${items[0].arxivId ?? items[0].externalId}`,
    items,
    sourceCount: new Set(items.map((i) => i.kind)).size,
    primary: items[0],
  };
}

/** A model that returns whatever payload the test specifies. */
function respondWith(payload: unknown): GenerateImpl {
  return async () => ({ text: JSON.stringify(payload) });
}

const goodResponse = {
  summary: "FlashLite reduces attention memory use for long sequences.",
  whyItMatters: "It cuts memory use by 40% versus FlashAttention-2, which matters at long context.",
  claims: [
    {
      text: "cuts memory use by 40% versus FlashAttention-2",
      quotedFrom: "reduces memory use by 40% versus FlashAttention-2",
    },
  ],
};

describe("collectQuotableSource", () => {
  it("joins the text of every item in the cluster", () => {
    const source = collectQuotableSource(
      cluster([
        item({ text: "arXiv abstract." }),
        item({ kind: "HUGGINGFACE", externalId: "2607.22534", text: "HF summary." }),
      ]),
    );

    expect(source).toContain("arXiv abstract.");
    expect(source).toContain("HF summary.");
  });

  it("deduplicates identical text across sources", () => {
    const source = collectQuotableSource(
      cluster([
        item({ text: "Same abstract." }),
        item({ kind: "HUGGINGFACE", externalId: "x", text: "Same abstract." }),
      ]),
    );

    expect(source).toBe("Same abstract.");
  });

  it("returns an empty string when no item has text", () => {
    expect(collectQuotableSource(cluster([item({ text: null })]))).toBe("");
  });
});

describe("buildSummarizationPrompt", () => {
  it("delimits source text so the model knows what it may quote", () => {
    const prompt = buildSummarizationPrompt({
      title: "A paper",
      sourceText: "The abstract.",
      authors: ["Ada"],
      sourceKinds: ["ARXIV"],
    });

    expect(prompt).toContain("<<<SOURCE");
    expect(prompt).toContain("SOURCE>>>");
    expect(prompt).toContain("The abstract.");
  });

  it("forbids claims outright when there is no source text to quote", () => {
    const prompt = buildSummarizationPrompt({
      title: "A link post",
      sourceText: null,
      authors: [],
      sourceKinds: ["HACKERNEWS"],
    });

    expect(prompt).toContain("claims MUST be an empty array");
  });

  it("truncates a long author list rather than sending hundreds of names", () => {
    const authors = Array.from({ length: 30 }, (_, i) => `Author ${i}`);
    const prompt = buildSummarizationPrompt({
      title: "Big collaboration",
      sourceText: "Text.",
      authors,
      sourceKinds: ["ARXIV"],
    });

    expect(prompt).toContain("and 22 others");
    expect(prompt).not.toContain("Author 29");
  });
});

describe("SUMMARIZATION_SYSTEM_INSTRUCTION", () => {
  it("instructs the model to omit unsupported comparisons rather than invent them", () => {
    expect(SUMMARIZATION_SYSTEM_INSTRUCTION).toContain("OMIT THE STATEMENT");
    expect(SUMMARIZATION_SYSTEM_INSTRUCTION).toContain("verbatim");
  });

  it("keeps the take contextual, not advisory — out of scope per the spec", () => {
    expect(SUMMARIZATION_SYSTEM_INSTRUCTION).toContain("never tell the reader what to do");
  });
});

describe("summarizeCluster", () => {
  it("returns summary, take, and claims for a well-formed response", async () => {
    const result = await summarizeCluster(cluster(), {
      generateImpl: respondWith(goodResponse),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary).toContain("FlashLite");
    expect(result.value.claims).toHaveLength(1);
  });

  it("retains the exact source text claims were quoted from, for Task 7 to verify against", async () => {
    const result = await summarizeCluster(cluster(), {
      generateImpl: respondWith(goodResponse),
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.quotableSource).toBe(
      "We propose FlashLite, which reduces memory use by 40% versus FlashAttention-2.",
    );
  });

  it("sends the system instruction rather than inlining it per item", async () => {
    const instructions: unknown[] = [];
    const generateImpl: GenerateImpl = async (args) => {
      instructions.push(args.config.systemInstruction);
      return { text: JSON.stringify(goodResponse) };
    };

    await summarizeCluster(cluster(), { generateImpl });

    expect(instructions[0]).toBe(SUMMARIZATION_SYSTEM_INSTRUCTION);
  });

  it("rejects a summary over the spec's word limit", async () => {
    vi.useFakeTimers();
    const promise = summarizeCluster(cluster(), {
      maxRetries: 0,
      generateImpl: respondWith({
        ...goodResponse,
        summary: Array.from({ length: SUMMARY_WORD_LIMIT + 20 }, () => "word").join(" "),
      }),
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("limit is");
  });

  /**
   * The trust-critical case. A model that fabricates claims for an item with no
   * quotable text must not produce a publishable result.
   */
  it("rejects claims on an item that has no source text to quote from", async () => {
    vi.useFakeTimers();
    const promise = summarizeCluster(cluster([item({ text: null })]), {
      maxRetries: 0,
      generateImpl: respondWith({
        summary: "A link post about attention.",
        whyItMatters: "It outperforms every prior method.",
        claims: [{ text: "outperforms every prior method", quotedFrom: "outperforms everything" }],
      }),
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("no quotable source");
  });

  it("accepts an empty claims array — a take making no comparison is correct", async () => {
    const result = await summarizeCluster(cluster(), {
      generateImpl: respondWith({
        summary: "A method for long-sequence attention.",
        whyItMatters: "Relevant to engineers working on long-context inference.",
        claims: [],
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.claims).toEqual([]);
  });

  it("returns an error rather than partial data when the response is malformed", async () => {
    vi.useFakeTimers();
    const promise = summarizeCluster(cluster(), {
      maxRetries: 0,
      generateImpl: respondWith({ summary: "Missing the other fields." }),
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalidResponse");
  });

  it("tells the model which sources cover the item", async () => {
    const prompts: string[] = [];
    const generateImpl: GenerateImpl = async (args) => {
      prompts.push(args.contents);
      return { text: JSON.stringify(goodResponse) };
    };

    await summarizeCluster(
      cluster([item(), item({ kind: "HUGGINGFACE", externalId: "2607.22534" })]),
      { generateImpl },
    );

    expect(prompts[0]).toContain("ARXIV, HUGGINGFACE");
  });
});

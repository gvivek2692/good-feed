/** @vitest-environment node */
import { describe, expect, it } from "vitest";

import { embedTexts, type EmbedImpl } from "@/lib/llm/embeddings";
import { EMBEDDING_DIMENSIONS, MODELS } from "@/lib/llm/models";

const vector = (n = EMBEDDING_DIMENSIONS): number[] => Array.from({ length: n }, () => 0.01);

describe("embedTexts", () => {
  it("returns one vector per input", async () => {
    const embedImpl: EmbedImpl = async ({ contents }) => ({
      embeddings: contents.map(() => ({ values: vector() })),
    });

    const result = await embedTexts(["a", "b", "c"], { embedImpl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
    expect(result.value[0]).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("requests 1536 dimensions so vectors fit the pgvector index limit", async () => {
    // The model returns 3072 by default; pgvector's HNSW/IVFFlat indexes cap at
    // 2000. The schema column is vector(1536).
    const configs: Record<string, unknown>[] = [];
    const embedImpl: EmbedImpl = async ({ contents, config }) => {
      configs.push(config);
      return { embeddings: contents.map(() => ({ values: vector() })) };
    };

    await embedTexts(["a"], { embedImpl });

    expect(configs[0].outputDimensionality).toBe(1536);
    expect(EMBEDDING_DIMENSIONS).toBeLessThanOrEqual(2000);
  });

  it("uses the pinned embedding model", async () => {
    const models: string[] = [];
    const embedImpl: EmbedImpl = async ({ model, contents }) => {
      models.push(model);
      return { embeddings: contents.map(() => ({ values: vector() })) };
    };

    await embedTexts(["a"], { embedImpl });

    expect(models[0]).toBe(MODELS.embedding);
  });

  it("rejects a dimension mismatch rather than letting it fail at insert time", async () => {
    const embedImpl: EmbedImpl = async ({ contents }) => ({
      embeddings: contents.map(() => ({ values: vector(3072) })),
    });

    const result = await embedTexts(["a"], { embedImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalidResponse");
    expect(result.error.message).toContain("3072");
  });

  it("rejects a response with the wrong number of embeddings", async () => {
    const embedImpl: EmbedImpl = async () => ({ embeddings: [{ values: vector() }] });

    const result = await embedTexts(["a", "b"], { embedImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("expected 2");
  });

  it("classifies a quota error as retryable rate limiting", async () => {
    const embedImpl: EmbedImpl = async () => {
      throw new Error("429 RESOURCE_EXHAUSTED");
    };

    const result = await embedTexts(["a"], { embedImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("rateLimit");
  });

  it("short-circuits an empty input without calling the API", async () => {
    let called = false;
    const embedImpl: EmbedImpl = async () => {
      called = true;
      return { embeddings: [] };
    };

    const result = await embedTexts([], { embedImpl });

    expect(called).toBe(false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

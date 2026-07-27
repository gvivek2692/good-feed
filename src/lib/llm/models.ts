/**
 * Pinned Gemini model ids.
 *
 * Verified against the live API on 2026-07-27 — model naming moves fast enough
 * that anything written from memory is likely stale. Re-verify with:
 *   curl -H "x-goog-api-key: $GEMINI_API_KEY" \
 *     https://generativelanguage.googleapis.com/v1beta/models
 *
 * `*-latest` aliases exist but are deliberately not used: a model changing
 * underneath the pipeline would silently change summaries and takes, which the
 * spec's trust constraint cannot tolerate.
 */
export const MODELS = {
  /** Summaries, takes, and deep-dive expansions. Newest stable flash tier. */
  generation: "gemini-3.6-flash",
  /** Topic classification — a much easier task, so the cheaper tier. */
  classification: "gemini-3.5-flash-lite",
  /** Embeddings for related-items similarity search. */
  embedding: "gemini-embedding-001",
} as const;

/**
 * Embedding dimension requested at call time.
 *
 * gemini-embedding-001 returns 3072 by default, but pgvector's HNSW and
 * IVFFlat indexes cap at 2000 dimensions. 1536 is requested via
 * `outputDimensionality` and matches the `vector(1536)` column in the schema.
 * Verified: the API honours the reduction.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Thinking token allowance for pipeline calls.
 *
 * Gemini 3.x flash models think by default and **cannot be told not to** —
 * `thinkingBudget: 0` is rejected as an invalid argument. Measured: an
 * unconstrained 5-token prompt spent 263 thinking tokens; at 128 it spends ~54.
 * Across per-item summarization at feed volume that difference is the dominant
 * cost, so the budget is set explicitly rather than left to default.
 */
export const THINKING_BUDGET = 128;

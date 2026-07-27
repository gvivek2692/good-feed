import { GoogleGenAI } from "@google/genai";

import { err, ok, type Result } from "@/lib/result";
import { EMBEDDING_DIMENSIONS, MODELS } from "@/lib/llm/models";
import { type LlmError } from "@/lib/llm/client";

/** The single seam where the SDK is called, so tests never hit the network. */
export type EmbedImpl = (args: {
  model: string;
  contents: string[];
  config: Record<string, unknown>;
}) => Promise<{ embeddings?: Array<{ values?: number[] }> }>;

export interface EmbedOptions {
  embedImpl?: EmbedImpl;
}

let cachedClient: GoogleGenAI | null = null;

function getEmbedImpl(): Result<EmbedImpl, LlmError> {
  if (!cachedClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return err({
        kind: "config",
        message: "GEMINI_API_KEY is not set. Copy .env.example to .env and fill it in.",
      });
    }
    cachedClient = new GoogleGenAI({ apiKey });
  }
  const client = cachedClient;
  return ok((args) => client.models.embedContent(args));
}

/**
 * Embeds texts for related-items similarity search.
 *
 * `outputDimensionality` is requested explicitly: the model returns 3072 by
 * default, which exceeds pgvector's 2000-dimension index limit. 1536 matches
 * the `vector(1536)` column in the schema, and the returned length is checked
 * rather than assumed — a dimension mismatch would fail at insert time with a
 * far less obvious error.
 */
export async function embedTexts(
  texts: string[],
  options: EmbedOptions = {},
): Promise<Result<number[][], LlmError>> {
  if (texts.length === 0) return ok([]);

  let embed = options.embedImpl;
  if (!embed) {
    const impl = getEmbedImpl();
    if (!impl.ok) return impl;
    embed = impl.value;
  }

  let response: { embeddings?: Array<{ values?: number[] }> };
  try {
    response = await embed({
      model: MODELS.embedding,
      contents: texts,
      config: { outputDimensionality: EMBEDDING_DIMENSIONS },
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/quota|rate limit|RESOURCE_EXHAUSTED|429/i.test(message)) {
      return err({ kind: "rateLimit", message });
    }
    return err({ kind: "transient", message });
  }

  const embeddings = response.embeddings;
  if (!embeddings || embeddings.length !== texts.length) {
    return err({
      kind: "invalidResponse",
      message: `expected ${texts.length} embeddings, received ${embeddings?.length ?? 0}`,
    });
  }

  const vectors: number[][] = [];
  for (const [index, embedding] of embeddings.entries()) {
    const values = embedding.values;
    if (!values) {
      return err({ kind: "invalidResponse", message: `embedding ${index} had no values` });
    }
    if (values.length !== EMBEDDING_DIMENSIONS) {
      return err({
        kind: "invalidResponse",
        message: `embedding ${index} had ${values.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
      });
    }
    vectors.push(values);
  }

  return ok(vectors);
}

/** Resets the cached client. Tests only. */
export function resetEmbeddingClientForTesting(): void {
  cachedClient = null;
}

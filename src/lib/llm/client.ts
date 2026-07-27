import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import { err, ok, type Result } from "@/lib/result";
import { MODELS, THINKING_BUDGET } from "@/lib/llm/models";

/**
 * LLM failure modes, distinguished so the pipeline can react appropriately:
 * `rateLimit` and `transient` are worth retrying, `invalidResponse` means the
 * model returned something unusable and the item should be dropped rather than
 * retried forever.
 */
export type LlmError =
  | { kind: "rateLimit"; message: string; retryAfterMs?: number }
  | { kind: "transient"; message: string; status?: number }
  | { kind: "invalidResponse"; message: string; detail?: unknown }
  | { kind: "config"; message: string };

export interface GenerateOptions<T> {
  prompt: string;
  /** Shape the response must satisfy. Enforced twice — by the API and by Zod. */
  schema: z.ZodType<T>;
  /** JSON Schema handed to the API so it constrains generation directly. */
  responseSchema: Record<string, unknown>;
  model?: string;
  /** Steering instructions kept out of the per-item prompt. */
  systemInstruction?: string;
  maxRetries?: number;
  /** Injected in tests; defaults to the real SDK call. */
  generateImpl?: GenerateImpl;
}

/** The single seam where the SDK is called, so tests never hit the network. */
export type GenerateImpl = (args: {
  model: string;
  contents: string;
  config: Record<string, unknown>;
}) => Promise<{ text?: string }>;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const BASE_DELAY_MS = 500;

let cachedClient: GoogleGenAI | null = null;

function getClient(): Result<GoogleGenAI, LlmError> {
  if (cachedClient) return ok(cachedClient);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return err({
      kind: "config",
      message: "GEMINI_API_KEY is not set. Copy .env.example to .env and fill it in.",
    });
  }

  cachedClient = new GoogleGenAI({ apiKey });
  return ok(cachedClient);
}

/** Maps an SDK/HTTP failure onto the error taxonomy above. */
function classifyError(cause: unknown): LlmError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const status = /\b(\d{3})\b/.exec(message)?.[1];
  const code = status ? Number(status) : undefined;

  if (code === 429 || /quota|rate limit|RESOURCE_EXHAUSTED/i.test(message)) {
    return { kind: "rateLimit", message };
  }
  if (code !== undefined && RETRYABLE_STATUS.has(code)) {
    return { kind: "transient", message, status: code };
  }
  return { kind: "invalidResponse", message };
}

function backoffMs(attempt: number): number {
  // Exponential with jitter, so parallel workers do not retry in lockstep.
  return BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 250);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generates a structured response, validated against `schema`.
 *
 * The response schema is enforced twice on purpose: the API constrains
 * generation, and Zod verifies what actually arrived. The API's constraint is
 * not a guarantee — a truncated or empty response still has to be caught.
 */
export async function generateStructured<T>(
  options: GenerateOptions<T>,
): Promise<Result<T, LlmError>> {
  const {
    prompt,
    schema,
    responseSchema,
    model = MODELS.generation,
    systemInstruction,
    maxRetries = 3,
    generateImpl,
  } = options;

  let call = generateImpl;
  if (!call) {
    const client = getClient();
    if (!client.ok) return client;
    call = (args) => client.value.models.generateContent(args);
  }

  let lastError: LlmError = { kind: "transient", message: "no attempt was made" };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let raw: string | undefined;
    try {
      const response = await call({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema,
          // Gemini 3.x flash cannot disable thinking; this caps it instead.
          thinkingConfig: { thinkingBudget: THINKING_BUDGET },
          ...(systemInstruction ? { systemInstruction } : {}),
        },
      });
      raw = response.text;
    } catch (cause) {
      lastError = classifyError(cause);
      const retryable = lastError.kind === "rateLimit" || lastError.kind === "transient";
      if (retryable && attempt < maxRetries) {
        // Honour a server-provided delay when one is available.
        const delay =
          lastError.kind === "rateLimit"
            ? (lastError.retryAfterMs ?? backoffMs(attempt))
            : backoffMs(attempt);
        await sleep(delay);
        continue;
      }
      return err(lastError);
    }

    if (!raw) {
      lastError = { kind: "invalidResponse", message: "model returned an empty response" };
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return err(lastError);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      lastError = {
        kind: "invalidResponse",
        message: "model response was not valid JSON",
        detail: raw.slice(0, 500),
      };
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return err(lastError);
    }

    const validated = schema.safeParse(parsed);
    if (validated.success) return ok(validated.data);

    // A schema mismatch is worth one more attempt — generation is
    // non-deterministic — but never persisted as partial data.
    lastError = {
      kind: "invalidResponse",
      message: "model response did not match the expected schema",
      detail: validated.error.issues,
    };
    if (attempt < maxRetries) {
      await sleep(backoffMs(attempt));
      continue;
    }
  }

  return err(lastError);
}

/** Resets the cached client. Tests only. */
export function resetClientForTesting(): void {
  cachedClient = null;
}

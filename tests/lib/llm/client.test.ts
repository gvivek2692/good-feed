/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { generateStructured, type GenerateImpl } from "@/lib/llm/client";
import { MODELS, THINKING_BUDGET } from "@/lib/llm/models";

const Summary = z.object({ summary: z.string(), wordCount: z.number() });

const responseSchema = {
  type: "OBJECT",
  properties: { summary: { type: "STRING" }, wordCount: { type: "INTEGER" } },
  required: ["summary", "wordCount"],
};

function base(generateImpl: GenerateImpl) {
  return { prompt: "summarize this", schema: Summary, responseSchema, generateImpl };
}

describe("generateStructured", () => {
  it("returns validated data on a well-formed response", async () => {
    const impl: GenerateImpl = async () => ({
      text: JSON.stringify({ summary: "A summary.", wordCount: 2 }),
    });

    const result = await generateStructured(base(impl));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary).toBe("A summary.");
  });

  it("caps thinking tokens explicitly — Gemini 3.x flash cannot disable thinking", async () => {
    // thinkingBudget: 0 is rejected by the API as an invalid argument, so the
    // budget is capped rather than removed. Unconstrained, a 5-token prompt
    // spent 263 thinking tokens; at 128 it spends ~54.
    const configs: Record<string, unknown>[] = [];
    const impl: GenerateImpl = async (args) => {
      configs.push(args.config);
      return { text: JSON.stringify({ summary: "x", wordCount: 1 }) };
    };

    await generateStructured(base(impl));

    expect(configs[0].thinkingConfig).toEqual({ thinkingBudget: THINKING_BUDGET });
    expect(THINKING_BUDGET).toBeGreaterThan(0);
  });

  it("requests JSON with a response schema so the API constrains generation", async () => {
    const configs: Record<string, unknown>[] = [];
    const impl: GenerateImpl = async (args) => {
      configs.push(args.config);
      return { text: JSON.stringify({ summary: "x", wordCount: 1 }) };
    };

    await generateStructured(base(impl));

    expect(configs[0].responseMimeType).toBe("application/json");
    expect(configs[0].responseSchema).toEqual(responseSchema);
  });

  it("defaults to the pinned generation model", async () => {
    const models: string[] = [];
    const impl: GenerateImpl = async (args) => {
      models.push(args.model);
      return { text: JSON.stringify({ summary: "x", wordCount: 1 }) };
    };

    await generateStructured(base(impl));

    expect(models[0]).toBe(MODELS.generation);
  });

  it("retries a rate-limit error and succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const impl: GenerateImpl = async () => {
      calls += 1;
      if (calls === 1) throw new Error("429 RESOURCE_EXHAUSTED: quota exceeded");
      return { text: JSON.stringify({ summary: "recovered", wordCount: 1 }) };
    };

    const promise = generateStructured(base(impl));
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("gives up after maxRetries and reports rateLimit", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const impl: GenerateImpl = async () => {
      calls += 1;
      throw new Error("429 quota exceeded");
    };

    const promise = generateStructured({ ...base(impl), maxRetries: 2 });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(calls).toBe(3); // initial + 2 retries
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("rateLimit");
  });

  it("retries transient 5xx errors", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const impl: GenerateImpl = async () => {
      calls += 1;
      if (calls < 3) throw new Error("503 Service Unavailable");
      return { text: JSON.stringify({ summary: "ok", wordCount: 1 }) };
    };

    const promise = generateStructured(base(impl));
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(calls).toBe(3);
    expect(result.ok).toBe(true);
  });

  it("never persists partial data when the response does not match the schema", async () => {
    vi.useFakeTimers();
    const impl: GenerateImpl = async () => ({
      text: JSON.stringify({ summary: "missing wordCount" }),
    });

    const promise = generateStructured({ ...base(impl), maxRetries: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalidResponse");
  });

  it("reports invalid JSON rather than throwing", async () => {
    vi.useFakeTimers();
    const impl: GenerateImpl = async () => ({ text: "not json at all {{{" });

    const promise = generateStructured({ ...base(impl), maxRetries: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalidResponse");
    expect(result.error.message).toContain("valid JSON");
  });

  it("reports an empty response rather than treating it as success", async () => {
    vi.useFakeTimers();
    const impl: GenerateImpl = async () => ({ text: undefined });

    const promise = generateStructured({ ...base(impl), maxRetries: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("empty");
  });

  it("passes a system instruction through when given", async () => {
    const configs: Record<string, unknown>[] = [];
    const impl: GenerateImpl = async (args) => {
      configs.push(args.config);
      return { text: JSON.stringify({ summary: "x", wordCount: 1 }) };
    };

    await generateStructured({ ...base(impl), systemInstruction: "Be terse." });

    expect(configs[0].systemInstruction).toBe("Be terse.");
  });
});

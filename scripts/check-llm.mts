import "dotenv/config";

import { z } from "zod";

import { generateStructured } from "@/lib/llm/client";
import { embedTexts } from "@/lib/llm/embeddings";
import { MODELS } from "@/lib/llm/models";

/**
 * Live smoke check against the Gemini API. Not part of `npm test` — the suite
 * mocks the transport. Run with: npx tsx scripts/check-llm.mts
 */
async function main(): Promise<void> {
  const Summary = z.object({ summary: z.string(), wordCount: z.number() });

  const generated = await generateStructured({
    prompt: "Summarize in one sentence: cats are small carnivorous mammals kept as pets.",
    schema: Summary,
    responseSchema: {
      type: "OBJECT",
      properties: { summary: { type: "STRING" }, wordCount: { type: "INTEGER" } },
      required: ["summary", "wordCount"],
    },
    // The generation-tier model's free quota is easily exhausted; the
    // classification tier exercises the same code path.
    model: MODELS.classification,
  });

  console.log(
    "generateStructured:",
    generated.ok ? JSON.stringify(generated.value) : `ERROR ${JSON.stringify(generated.error)}`,
  );

  const embedded = await embedTexts(["attention is all you need", "diffusion models"]);
  console.log(
    "embedTexts:",
    embedded.ok
      ? `${embedded.value.length} vectors x ${embedded.value[0].length} dims`
      : `ERROR ${JSON.stringify(embedded.error)}`,
  );
}

void main();

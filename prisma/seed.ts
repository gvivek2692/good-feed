import "dotenv/config";

import { prisma } from "../src/lib/db/client";

/**
 * The fixed topic taxonomy. Curated rather than derived from clustering — see
 * docs/spec/good-feed-v1.md, resolved decision 4. Users pick from this list at
 * signup, so the labels are user-facing.
 */
const TOPICS: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: "llm-training", label: "LLM Training" },
  { slug: "inference-optimization", label: "Inference Optimization" },
  { slug: "agents", label: "Agents" },
  { slug: "rag", label: "RAG & Retrieval" },
  { slug: "evaluation", label: "Evaluation & Benchmarks" },
  { slug: "multimodal", label: "Multimodal" },
  { slug: "reasoning", label: "Reasoning" },
  { slug: "alignment-safety", label: "Alignment & Safety" },
  { slug: "hardware-systems", label: "Hardware & Systems" },
  { slug: "open-models", label: "Open Models" },
  { slug: "robotics", label: "Robotics" },
  { slug: "speech-audio", label: "Speech & Audio" },
  { slug: "vision", label: "Vision" },
  { slug: "data-curation", label: "Data & Curation" },
  { slug: "tooling-infra", label: "Tooling & Infrastructure" },
];

async function main(): Promise<void> {
  // Upsert keyed on slug, so re-running updates labels without duplicating rows.
  for (const topic of TOPICS) {
    await prisma.topic.upsert({
      where: { slug: topic.slug },
      update: { label: topic.label },
      create: topic,
    });
  }

  const count = await prisma.topic.count();
  console.log(`Seeded ${TOPICS.length} topics. Total in database: ${count}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

/**
 * The fixed topic taxonomy — the single source of truth.
 *
 * Curated rather than derived from clustering (spec, resolved decision 4).
 * Both the database seed and the classifier import this list: duplicating the
 * slugs would let the two drift, and a classifier emitting a slug the database
 * has never seen fails silently at write time rather than at classification.
 */
export const TOPICS = [
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
] as const satisfies ReadonlyArray<{ slug: string; label: string }>;

export type TopicSlug = (typeof TOPICS)[number]["slug"];

export const TOPIC_SLUGS: readonly TopicSlug[] = TOPICS.map((topic) => topic.slug);

const SLUG_SET = new Set<string>(TOPIC_SLUGS);

/** Whether a string is a slug from the fixed taxonomy. */
export function isTopicSlug(value: string): value is TopicSlug {
  return SLUG_SET.has(value);
}

/**
 * Short disambiguations for the classifier prompt.
 *
 * The labels alone leave real overlap — a vLLM paper is inference-optimization
 * rather than tooling-infra, an agent benchmark is evaluation rather than
 * agents. Stating the boundary is cheaper than correcting the drift later.
 */
export const TOPIC_DESCRIPTIONS: Record<TopicSlug, string> = {
  "llm-training":
    "pretraining, fine-tuning, RLHF/RLAIF, optimizers, scaling laws, training recipes",
  "inference-optimization":
    "serving throughput and latency, quantization, KV-cache, speculative decoding, distillation for speed",
  agents: "tool-using and autonomous systems, planning, multi-agent orchestration, computer use",
  rag: "retrieval-augmented generation, embeddings, vector search, context construction",
  evaluation:
    "benchmarks, evals, leaderboards, measurement methodology, red-teaming for capability",
  multimodal: "models spanning two or more of text, image, video, audio",
  reasoning: "chain-of-thought, math and code reasoning, test-time compute, verification",
  "alignment-safety": "alignment, interpretability, jailbreaks, misuse, policy, model welfare",
  "hardware-systems":
    "GPUs and accelerators, kernels, distributed training systems, memory and networking",
  "open-models": "open-weight model releases and their licenses",
  robotics: "embodied agents, manipulation, navigation, vision-language-action models, simulation",
  "speech-audio": "ASR, TTS, music and audio generation, speech models",
  vision:
    "image and video understanding or generation, segmentation, detection, diffusion for images",
  "data-curation": "datasets, synthetic data, filtering, deduplication, data quality",
  "tooling-infra":
    "developer frameworks, libraries, orchestration, observability, deployment platforms",
};

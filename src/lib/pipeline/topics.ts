import { z } from "zod";

import { generateStructured, type GenerateImpl, type LlmError } from "@/lib/llm/client";
import { MODELS } from "@/lib/llm/models";
import { type Cluster } from "@/lib/pipeline/clustering";
import { ok, type Result } from "@/lib/result";
import { isTopicSlug, TOPIC_DESCRIPTIONS, TOPICS, type TopicSlug } from "@/lib/topics/taxonomy";

/**
 * Minimum confidence for an assignment to be persisted.
 *
 * Self-reported LLM confidence is not calibrated. Measured over 37 real
 * assignments (`scripts/check-topics.mts`): only 7 distinct values, snapped to
 * a 0.05 grid, min 0.60, and 34/37 at 0.80 or above. Nothing was filtered.
 *
 * Kept at 0.55 deliberately. Raising it until it rejects something would be
 * tuning to make the threshold look useful, and would discard genuine secondary
 * topics (rag 0.75, reasoning 0.80) on the strength of a number the model is
 * rounding anyway. It stays as a floor against a model that reports low
 * confidence, which this one does not yet do — revisit if that changes, or if a
 * calibrated signal becomes available.
 */
export const CONFIDENCE_THRESHOLD = 0.55;

/**
 * An item genuinely spanning more than three of these topics is a sign the
 * classifier is hedging across the taxonomy rather than deciding.
 */
export const MAX_TOPICS_PER_ITEM = 3;

const ClassificationSchema = z.object({
  topics: z
    .array(
      z.object({
        slug: z.string(),
        confidence: z.number(),
      }),
    )
    .max(TOPICS.length),
});

const CLASSIFICATION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    topics: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          slug: { type: "STRING", enum: [...TOPICS.map((topic) => topic.slug)] },
          confidence: { type: "NUMBER" },
        },
        required: ["slug", "confidence"],
      },
    },
  },
  required: ["topics"],
};

const CLASSIFICATION_SYSTEM_INSTRUCTION = `You assign topics to AI research and engineering items for a personalized feed.

Assign only topics that are genuinely central to the item. Users select topics to filter their feed,
so a marginal assignment puts an item in front of someone who did not ask for it.

Rules:
- Use ONLY slugs from the provided taxonomy. Never invent a slug.
- Assign at most ${MAX_TOPICS_PER_ITEM} topics. Most items warrant one or two.
- confidence is 0.0-1.0: how certain you are the topic is central, not merely mentioned.
- If nothing fits, return an empty array. An unclassified item is better than a wrong topic.
- Judge by the item's actual contribution, not by vocabulary it happens to use. A paper that
  benchmarks agents is evaluation; a paper that builds one is agents.`;

const TAXONOMY_BLOCK = TOPICS.map(
  (topic) => `- ${topic.slug}: ${TOPIC_DESCRIPTIONS[topic.slug]}`,
).join("\n");

export interface TopicAssignment {
  slug: TopicSlug;
  confidence: number;
}

export interface ClassifiedCluster {
  clusterId: string;
  topics: TopicAssignment[];
  /** True when no topic cleared the threshold — the item is stored with none. */
  unclassified: boolean;
  /** Slugs the model invented, kept for the run log. */
  rejected: string[];
}

export interface ClassifyOptions {
  generateImpl?: GenerateImpl;
  maxRetries?: number;
}

function buildClassificationPrompt(cluster: Cluster): string {
  const { primary } = cluster;
  const text = primary.text?.trim();

  const parts = ["TAXONOMY:", TAXONOMY_BLOCK, "", `TITLE: ${primary.title}`];

  if (text) {
    parts.push("", "TEXT:", text.slice(0, 4000));
  } else {
    parts.push("", "No body text available — classify from the title alone,");
    parts.push("and prefer an empty array if the title is not specific enough.");
  }

  return parts.join("\n");
}

/**
 * Assigns fixed-taxonomy topics to a cluster.
 *
 * Unknown slugs are dropped rather than failing the item: one hallucinated
 * label should not discard the assignments that were valid. Everything below
 * `CONFIDENCE_THRESHOLD` is dropped too, leaving the item unclassified — the
 * spec forbids force-fitting an item into a topic to avoid an empty result.
 */
export async function classifyCluster(
  cluster: Cluster,
  options: ClassifyOptions = {},
): Promise<Result<ClassifiedCluster, LlmError>> {
  const generated = await generateStructured({
    prompt: buildClassificationPrompt(cluster),
    schema: ClassificationSchema,
    responseSchema: CLASSIFICATION_RESPONSE_SCHEMA,
    systemInstruction: CLASSIFICATION_SYSTEM_INSTRUCTION,
    // Labeling into a fixed list is the cheap model's job; `generation` is
    // reserved for summaries and takes, and has materially less free-tier quota.
    model: MODELS.classification,
    generateImpl: options.generateImpl,
    maxRetries: options.maxRetries,
  });

  if (!generated.ok) return generated;

  const rejected: string[] = [];
  const byslug = new Map<TopicSlug, number>();

  for (const assignment of generated.value.topics) {
    if (!isTopicSlug(assignment.slug)) {
      rejected.push(assignment.slug);
      continue;
    }

    // A model that reports 1.4 has ignored the scale; clamping keeps a usable
    // ordering without inventing a value.
    const confidence = Math.min(1, Math.max(0, assignment.confidence));
    if (confidence < CONFIDENCE_THRESHOLD) continue;

    const existing = byslug.get(assignment.slug);
    if (existing === undefined || confidence > existing) {
      byslug.set(assignment.slug, confidence);
    }
  }

  const topics = [...byslug.entries()]
    .map(([slug, confidence]) => ({ slug, confidence }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_TOPICS_PER_ITEM);

  return ok({
    clusterId: cluster.id,
    topics,
    unclassified: topics.length === 0,
    rejected,
  });
}

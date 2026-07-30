import { z } from "zod";

/**
 * The shape every source adapter produces. Downstream stages (clustering,
 * summarization, ranking) work only against this, never a source's native
 * format.
 */
export const NormalizedItem = z.object({
  /** Stable id within the source. Combined with `kind` it must be unique. */
  externalId: z.string().min(1),
  kind: z.enum(["ARXIV", "HUGGINGFACE", "HACKERNEWS", "GITHUB"]),
  title: z.string().min(1),
  authors: z.array(z.string()),
  publishedAt: z.date(),
  /** Where a reader goes to read the thing itself. */
  canonicalUrl: z.url(),
  /** Where the item was found — the HN thread, the arXiv abstract page. */
  sourceUrl: z.url(),
  /** Abstract or self-text. Absent for HN link posts. */
  text: z.string().nullable(),
  /**
   * Version-stripped arXiv id (e.g. "2607.22534"), when the item is a paper.
   * This is the join key for the research cluster — arXiv and HuggingFace
   * Papers cluster on this and nothing else. Null for HN items, which never
   * cluster with papers. See docs/adr/001.
   */
  arxivId: z.string().nullable(),
  /**
   * Source-native ranking signals, kept separate from `text` because ranking
   * consumes them directly. Shapes differ per source by design.
   */
  signals: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  /** The untouched upstream payload, retained for reprocessing. */
  raw: z.unknown(),
});

export type NormalizedItem = z.infer<typeof NormalizedItem>;

/**
 * Adapter failure modes. Distinguished so the pipeline can retry transport
 * errors while treating parse failures as permanent for that payload.
 */
export type SourceError =
  | { kind: "http"; status: number; message: string }
  | { kind: "network"; message: string }
  | { kind: "parse"; message: string; detail?: unknown };

export interface FetchOptions {
  /** Only items published at or after this instant. */
  since: Date;
  /** Upper bound on items returned. Adapters may return fewer. */
  limit?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

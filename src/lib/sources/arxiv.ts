import { XMLParser } from "fast-xml-parser";

import { err, ok, type Result } from "@/lib/result";
import { type FetchOptions, type NormalizedItem, type SourceError } from "@/lib/sources/types";

const ARXIV_API = "https://export.arxiv.org/api/query";

/** Categories worth watching. cs.LG and cs.CL carry most LLM work. */
const CATEGORIES = ["cs.AI", "cs.LG", "cs.CL", "cs.CV", "cs.RO", "cs.NE"] as const;

/**
 * fast-xml-parser collapses repeated elements to a single object when only one
 * is present, so `author` is an object for single-author papers and an array
 * otherwise. Same for `category` and `link`.
 */
function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

interface RawLink {
  "@_href"?: string;
  "@_rel"?: string;
  "@_type"?: string;
  "@_title"?: string;
}

interface RawEntry {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  updated?: string;
  author?: { name?: string } | Array<{ name?: string }>;
  category?: { "@_term"?: string } | Array<{ "@_term"?: string }>;
  link?: RawLink | RawLink[];
  "arxiv:comment"?: string;
  "arxiv:primary_category"?: { "@_term"?: string };
}

/** arXiv pads titles and abstracts with newlines and runs of spaces. */
function clean(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** "http://arxiv.org/abs/2607.22534v1" -> "2607.22534v1" */
function extractId(idUrl: string): string | null {
  const match = /\/abs\/(.+)$/.exec(idUrl);
  return match ? match[1] : null;
}

function normalizeEntry(entry: RawEntry): NormalizedItem | null {
  const idUrl = entry.id;
  if (!idUrl) return null;

  const externalId = extractId(idUrl);
  const title = clean(entry.title);
  const published = entry.published;
  if (!externalId || !title || !published) return null;

  const publishedAt = new Date(published);
  if (Number.isNaN(publishedAt.getTime())) return null;

  const authors = toArray(entry.author)
    .map((a) => clean(a?.name))
    .filter((name) => name.length > 0);

  const categories = toArray(entry.category)
    .map((c) => c?.["@_term"])
    .filter((term): term is string => typeof term === "string");

  const pdfUrl = toArray(entry.link).find((l) => l?.["@_title"] === "pdf")?.["@_href"];
  const absUrl = `https://arxiv.org/abs/${externalId}`;

  // A linked GitHub repo is a ranking signal — arXiv puts it in the comment.
  const comment = clean(entry["arxiv:comment"]);
  const repoUrl = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/i.exec(comment)?.[0] ?? null;

  return {
    externalId,
    kind: "ARXIV",
    title,
    authors,
    publishedAt,
    canonicalUrl: pdfUrl ?? absUrl,
    sourceUrl: absUrl,
    text: clean(entry.summary) || null,
    // Version-stripped, so v1 and v2 of a paper join to the same cluster.
    arxivId: externalId.replace(/v\d+$/, ""),
    signals: {
      primaryCategory: entry["arxiv:primary_category"]?.["@_term"] ?? null,
      categoryCount: categories.length,
      authorCount: authors.length,
      repoUrl,
    },
    raw: entry,
  };
}

/**
 * Parses an arXiv Atom feed. Exported so tests can exercise parsing against
 * fixtures without any network involvement.
 */
export function parseAtomFeed(xml: string): Result<NormalizedItem[], SourceError> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Version suffixes like "2607.22534v1" must stay strings, and so must
    // numeric-looking author names.
    parseTagValue: false,
    parseAttributeValue: false,
  });

  let parsed: { feed?: { entry?: RawEntry | RawEntry[] } };
  try {
    parsed = parser.parse(xml) as { feed?: { entry?: RawEntry | RawEntry[] } };
  } catch (cause) {
    return err({
      kind: "parse",
      message: "arXiv response was not valid XML",
      detail: cause,
    });
  }

  if (!parsed.feed) {
    return err({ kind: "parse", message: "arXiv response had no <feed> element" });
  }

  // A feed with zero results legitimately has no <entry> elements.
  const entries = toArray(parsed.feed.entry);
  const items = entries.map(normalizeEntry).filter((item): item is NormalizedItem => item !== null);

  return ok(items);
}

export async function fetchRecent(
  options: FetchOptions,
): Promise<Result<NormalizedItem[], SourceError>> {
  const { since, limit = 100, fetchImpl = fetch } = options;

  const query = new URLSearchParams({
    search_query: CATEGORIES.map((c) => `cat:${c}`).join(" OR "),
    start: "0",
    max_results: String(limit),
    sortBy: "submittedDate",
    sortOrder: "descending",
  });

  let response: Response;
  try {
    response = await fetchImpl(`${ARXIV_API}?${query.toString()}`);
  } catch (cause) {
    return err({
      kind: "network",
      message: cause instanceof Error ? cause.message : "arXiv request failed",
    });
  }

  if (!response.ok) {
    return err({
      kind: "http",
      status: response.status,
      message: `arXiv returned ${response.status}`,
    });
  }

  const parsed = parseAtomFeed(await response.text());
  if (!parsed.ok) return parsed;

  // arXiv has no server-side date filter; sortBy=submittedDate lets us trim here.
  return ok(parsed.value.filter((item) => item.publishedAt >= since));
}

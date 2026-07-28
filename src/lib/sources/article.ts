import { err, ok, type Result } from "@/lib/result";
import { type SourceError } from "@/lib/sources/types";

/**
 * Fetches the readable text behind a link.
 *
 * Hacker News link posts carry a URL and no body, so the pipeline saw only a
 * title and produced a 40-word deep dive. The linked page is the actual source
 * material and is already stored on the item; this reads it.
 *
 * Deliberately narrow. It fetches one page — the one an item already points at
 * — and follows no links from it. That is a fetcher, not a crawler.
 */

/** Cap on downloaded bytes. A feed item's source should not be a 10MB page. */
const MAX_BYTES = 2_000_000;

/** Cap on extracted text handed to the model. ~30k chars is far past an abstract. */
const MAX_TEXT_CHARS = 30_000;

const TIMEOUT_MS = 15_000;

/**
 * Rewrites known URLs to a plain-text equivalent.
 *
 * A GitHub blob page is 396KB of application chrome around the file; the raw
 * URL is the same content as 24KB of markdown. Measured on the SlopCodeBench
 * post that surfaced this gap.
 */
export function toReadableUrl(url: string): string {
  const github = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url);
  if (github) {
    return `https://raw.githubusercontent.com/${github[1]}/${github[2]}/${github[3]}`;
  }

  // arXiv abstract pages are already handled by the arXiv adapter; the PDF is
  // useless here, so prefer the abstract page over a direct PDF link.
  const arxivPdf = /^https?:\/\/arxiv\.org\/pdf\/([\d.]+)(v\d+)?(\.pdf)?$/.exec(url);
  if (arxivPdf) return `https://arxiv.org/abs/${arxivPdf[1]}`;

  return url;
}

/** Elements whose contents are never article text. */
const STRIP_BLOCKS =
  /<(script|style|noscript|svg|nav|header|footer|aside|form|button|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Extracts readable text from HTML.
 *
 * A full readability implementation would be a dependency (AGENTS.md: ask
 * first). This is the crude version: strip non-content elements, prefer
 * `<article>` or `<main>` when present, then take the text. Good enough to tell
 * an explainer what a page says, and its failure mode is extra boilerplate
 * rather than wrong content.
 */
export function extractText(html: string): string {
  let working = html.replace(STRIP_BLOCKS, " ");

  // Prefer the semantic content container when the page provides one.
  const container =
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(working) ??
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(working);
  if (container) working = container[1];

  return working
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** Strips markdown syntax that adds noise without meaning for a summarizer. */
export function cleanMarkdown(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, "") // frontmatter
    .replace(/```[\s\S]*?```/g, " [code block] ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links keep their text
    .replace(/<\/?[a-z][^>]*>/gi, " ") // inline html
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export interface ArticleFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Fetches and extracts the text of a linked page.
 *
 * Returns an error rather than throwing so a failed fetch degrades to the
 * title-only path instead of failing the item.
 */
export async function fetchArticleText(
  url: string,
  options: ArticleFetchOptions = {},
): Promise<Result<string, SourceError>> {
  const { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = options;
  const target = toReadableUrl(url);

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return err({ kind: "parse", message: `not a valid url: ${target}` });
  }

  // Only public web content. Blocks the SSRF shapes that matter when the URL
  // comes from a third-party feed rather than from us.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return err({ kind: "parse", message: `unsupported protocol: ${parsed.protocol}` });
  }
  if (
    /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[?::1)/.test(parsed.hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(parsed.hostname)
  ) {
    return err({ kind: "parse", message: `refusing to fetch private address: ${parsed.hostname}` });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(target, {
      signal: controller.signal,
      headers: { "user-agent": "good-feed/0.1 (+https://github.com/gvivek2692/good-feed)" },
    });

    if (!response.ok) {
      return err({ kind: "http", status: response.status, message: `fetch failed for ${target}` });
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/|application\/(json|xml|xhtml)/i.test(contentType)) {
      return err({ kind: "parse", message: `not a text document: ${contentType}` });
    }

    const body = await response.text();
    if (body.length > MAX_BYTES) {
      return err({ kind: "parse", message: `document too large: ${body.length} bytes` });
    }

    const isMarkdown =
      /\.(md|markdown|txt)$/i.test(parsed.pathname) || /text\/plain/i.test(contentType);
    const text = isMarkdown ? cleanMarkdown(body) : extractText(body);

    if (text.length < 200) {
      return err({ kind: "parse", message: `too little readable text: ${text.length} chars` });
    }

    return ok(text.slice(0, MAX_TEXT_CHARS));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err({ kind: "network", message: `${message} (${target})` });
  } finally {
    clearTimeout(timer);
  }
}

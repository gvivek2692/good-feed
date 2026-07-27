/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fetchRecent, fetchTerm, parseSearchResponse } from "@/lib/sources/hackernews";

const fixture: unknown = JSON.parse(
  readFileSync(join(process.cwd(), "tests/fixtures/hn-recent.json"), "utf-8"),
);

describe("parseSearchResponse", () => {
  it("normalizes every hit in the fixture", () => {
    const result = parseSearchResponse(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeGreaterThanOrEqual(50);
    for (const item of result.value) {
      expect(item.kind).toBe("HACKERNEWS");
      expect(item.externalId).not.toHaveLength(0);
      expect(item.sourceUrl).toMatch(/^https:\/\/news\.ycombinator\.com\/item\?id=/);
      expect(typeof item.signals.points).toBe("number");
    }
  });

  it("uses the HN thread as canonicalUrl for text posts that have no external link", () => {
    const result = parseSearchResponse({
      hits: [
        {
          objectID: "111",
          title: "Ask HN: something",
          url: null,
          created_at: "2026-07-01T00:00:00Z",
          points: 42,
        },
      ],
    });

    if (!result.ok) throw new Error("failed to parse");
    expect(result.value[0].canonicalUrl).toBe("https://news.ycombinator.com/item?id=111");
    expect(result.value[0].signals.isTextPost).toBe("true");
  });

  it("computes velocity signals without dividing by a near-zero age", () => {
    const result = parseSearchResponse({
      hits: [
        {
          objectID: "222",
          title: "Brand new story",
          url: "https://example.com",
          created_at: new Date().toISOString(),
          points: 100,
          num_comments: 50,
        },
      ],
    });

    if (!result.ok) throw new Error("failed to parse");
    const { pointsPerHour, commentsPerHour } = result.value[0].signals;

    expect(Number(pointsPerHour)).toBeLessThanOrEqual(100);
    expect(Number(pointsPerHour)).toBeGreaterThan(0);
    expect(Number(commentsPerHour)).toBeLessThanOrEqual(50);
  });

  it("drops individual malformed hits rather than failing the whole batch", () => {
    const result = parseSearchResponse({
      hits: [
        { objectID: "333" }, // no title, no created_at
        { title: "no objectID", created_at: "2026-07-01T00:00:00Z" },
        {
          objectID: "444",
          title: "Valid",
          url: "https://example.com",
          created_at: "2026-07-01T00:00:00Z",
          points: 10,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].title).toBe("Valid");
  });

  it("returns a parse error when the response has no hits array", () => {
    const result = parseSearchResponse({ unexpected: "shape" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("parse");
  });
});

describe("fetchTerm", () => {
  it("returns an http error for a non-ok response", async () => {
    const fetchImpl = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof fetch;

    const result = await fetchTerm("AI", { since: new Date(0), fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: "http", status: 429 });
  });

  it("sends one term per request — Algolia does not support boolean OR in `query`", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ hits: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchTerm("LLM", { since: new Date(0), fetchImpl });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("query=LLM");
    expect(urls[0]).not.toContain("OR");
  });
});

describe("fetchRecent", () => {
  it("queries each term separately and merges the results", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ hits: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchRecent({ since: new Date(0), fetchImpl });

    // One request per configured term, never a single OR-joined query.
    expect(urls.length).toBeGreaterThan(1);
  });

  it("deduplicates stories matched by more than one term", async () => {
    const hit = {
      objectID: "999",
      title: "Matches several terms",
      url: "https://example.com",
      created_at: "2026-07-01T00:00:00Z",
      points: 50,
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ hits: [hit] }), { status: 200 })) as unknown as typeof fetch;

    const result = await fetchRecent({ since: new Date(0), fetchImpl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Every term returned the same story; it must appear once.
    expect(result.value).toHaveLength(1);
  });

  it("survives one term failing as long as another succeeds", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return new Response("boom", { status: 500 });
      return new Response(
        JSON.stringify({
          hits: [
            {
              objectID: `ok-${call}`,
              title: "Fine",
              url: "https://example.com",
              created_at: "2026-07-01T00:00:00Z",
              points: 20,
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await fetchRecent({ since: new Date(0), fetchImpl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);
  });

  it("reports an error only when every term fails", async () => {
    const fetchImpl = (async () =>
      new Response("down", { status: 500 })) as unknown as typeof fetch;

    const result = await fetchRecent({ since: new Date(0), fetchImpl });

    expect(result.ok).toBe(false);
  });
});

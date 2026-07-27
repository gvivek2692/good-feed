/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseAtomFeed } from "@/lib/sources/arxiv";
import { fetchDay, fetchRecent, parseDailyPapers } from "@/lib/sources/huggingface";

const hfFixture: unknown = JSON.parse(
  readFileSync(join(process.cwd(), "tests/fixtures/hf-daily-papers.json"), "utf-8"),
);
const arxivFixture = readFileSync(join(process.cwd(), "tests/fixtures/arxiv-recent.xml"), "utf-8");

describe("parseDailyPapers", () => {
  it("normalizes every entry in the fixture", () => {
    const result = parseDailyPapers(hfFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeGreaterThanOrEqual(200);
    for (const item of result.value) {
      expect(item.kind).toBe("HUGGINGFACE");
      expect(item.arxivId).not.toBeNull();
      expect(item.sourceUrl).toMatch(/^https:\/\/huggingface\.co\/papers\//);
      expect(typeof item.signals.upvotes).toBe("number");
    }
  });

  it("strips version suffixes so v1 and v2 join to the same cluster", () => {
    const result = parseDailyPapers([
      {
        paper: { id: "2607.22534v2", title: "Versioned", publishedAt: "2026-07-24T00:00:00Z" },
      },
    ]);

    if (!result.ok) throw new Error("failed to parse");
    expect(result.value[0].arxivId).toBe("2607.22534");
    expect(result.value[0].externalId).toBe("2607.22534");
  });

  it("normalizes githubRepo to an owner/repo slug for comparison against other sources", () => {
    const result = parseDailyPapers([
      {
        paper: {
          id: "2607.00001",
          title: "With Repo",
          publishedAt: "2026-07-24T00:00:00Z",
          githubRepo: "https://github.com/SonyResearch/SPA",
          githubStars: 42,
        },
      },
    ]);

    if (!result.ok) throw new Error("failed to parse");
    expect(result.value[0].signals.repoSlug).toBe("sonyresearch/spa");
    expect(result.value[0].signals.githubStars).toBe(42);
  });

  it("drops malformed entries rather than failing the batch", () => {
    const result = parseDailyPapers([
      { paper: { id: "2607.00002" } }, // no title
      { notAPaper: true },
      { paper: { id: "2607.00003", title: "Valid", publishedAt: "2026-07-24T00:00:00Z" } },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].title).toBe("Valid");
  });

  it("returns a parse error when the response is not an array", () => {
    const result = parseDailyPapers({ unexpected: "shape" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("parse");
  });
});

/**
 * The reason this source exists. arXiv and HN share zero items; HuggingFace is
 * what makes cross-source coverage a usable ranking signal. See docs/adr/001.
 */
describe("cross-source join with arXiv", () => {
  it("joins a substantial number of HF papers to the arXiv corpus by id", () => {
    const hf = parseDailyPapers(hfFixture);
    const arxiv = parseAtomFeed(arxivFixture);
    if (!hf.ok || !arxiv.ok) throw new Error("fixtures failed to parse");

    const arxivIds = new Set(arxiv.value.map((item) => item.arxivId));
    const joined = hf.value.filter((item) => item.arxivId && arxivIds.has(item.arxivId));

    // 91 real pairs were measured when the fixtures were captured.
    expect(joined.length).toBeGreaterThanOrEqual(50);
  });

  it("gives both sides of a joined pair the same arxivId", () => {
    const hf = parseDailyPapers(hfFixture);
    const arxiv = parseAtomFeed(arxivFixture);
    if (!hf.ok || !arxiv.ok) throw new Error("fixtures failed to parse");

    const arxivById = new Map(arxiv.value.map((item) => [item.arxivId, item]));
    const pair = hf.value.find((item) => item.arxivId && arxivById.has(item.arxivId));

    expect(pair).toBeDefined();
    if (!pair?.arxivId) return;
    expect(arxivById.get(pair.arxivId)?.arxivId).toBe(pair.arxivId);
  });

  it("carries repo coverage far above raw arXiv, which is why it was added", () => {
    const hf = parseDailyPapers(hfFixture);
    if (!hf.ok) throw new Error("fixture failed to parse");

    const withRepo = hf.value.filter((item) => item.signals.repoSlug !== null);
    const ratio = withRepo.length / hf.value.length;

    // Measured at 56% on HF vs 4.4% on raw arXiv.
    expect(ratio).toBeGreaterThan(0.3);
  });
});

describe("fetchDay", () => {
  it("returns an http error for a non-ok response", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const result = await fetchDay(new Date("2026-07-20"), { fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: "http", status: 500 });
  });

  it("requests the API's day-scoped endpoint", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    await fetchDay(new Date("2026-07-20T12:00:00Z"), { fetchImpl });

    expect(urls[0]).toContain("date=2026-07-20");
  });
});

describe("fetchRecent", () => {
  it("requests one day at a time across the window", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    const since = new Date(Date.now() - 4 * 24 * 3_600_000);
    await fetchRecent({ since, fetchImpl });

    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it("caps the window so a stale `since` cannot fan out unbounded", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    await fetchRecent({ since: new Date("2020-01-01"), fetchImpl });

    expect(calls).toBeLessThanOrEqual(30);
  });

  it("keeps the highest-upvote snapshot when a paper trends across several days", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return new Response(
        JSON.stringify([
          {
            paper: {
              id: "2607.11111",
              title: "Trending paper",
              publishedAt: "2026-07-20T00:00:00Z",
              upvotes: call * 10,
            },
          },
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const since = new Date(Date.now() - 3 * 24 * 3_600_000);
    const result = await fetchRecent({ since, fetchImpl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(Number(result.value[0].signals.upvotes)).toBeGreaterThanOrEqual(30);
  });

  it("survives one day failing as long as another succeeds", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return new Response("boom", { status: 503 });
      return new Response(
        JSON.stringify([
          {
            paper: { id: `2607.2222${call}`, title: "Fine", publishedAt: "2026-07-20T00:00:00Z" },
          },
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const since = new Date(Date.now() - 3 * 24 * 3_600_000);
    const result = await fetchRecent({ since, fetchImpl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);
  });
});

/**
 * Parses the real captured trending page. The fixture is stored verbatim rather
 * than trimmed: a hand-edited fixture would prove the parser works on markup we
 * wrote, which is not the thing that has to keep working.
 * @vitest-environment node
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fetchTrendingRepos, parseTrendingRow } from "@/lib/sources/github";

const FIXTURE = readFileSync(
  join(process.cwd(), "tests/fixtures/github-trending-daily.html"),
  "utf-8",
);

const NOW = new Date("2026-07-30T12:00:00Z");

function respond(body: string, status = 200): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { "content-type": "text/html" } })) as typeof fetch;
}

describe("fetchTrendingRepos", () => {
  it("parses every repository row from the real trending page", async () => {
    const result = await fetchTrendingRepos({ fetchImpl: respond(FIXTURE), now: NOW });

    if (!result.ok) throw new Error(`expected success, got ${result.error.message}`);
    expect(result.value.length).toBeGreaterThanOrEqual(10);
    expect(result.value.every((item) => item.kind === "GITHUB")).toBe(true);
  });

  it("extracts the fields the pipeline depends on", async () => {
    const result = await fetchTrendingRepos({ fetchImpl: respond(FIXTURE), now: NOW });
    if (!result.ok) throw new Error("expected success");

    const item = result.value[0];
    expect(item.title).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(item.canonicalUrl).toBe(`https://github.com/${item.title}`);
    expect(item.externalId).toMatch(/^\d+$/);
    expect(item.authors[0]).toBe(item.title.split("/")[0]);
  });

  /** "N stars today" is the whole reason this source exists. */
  it("reads the momentum signal, not just the total star count", async () => {
    const result = await fetchTrendingRepos({ fetchImpl: respond(FIXTURE), now: NOW });
    if (!result.ok) throw new Error("expected success");

    const withMomentum = result.value.filter((item) => Number(item.signals.starsToday) > 0);
    expect(withMomentum.length).toBeGreaterThan(5);

    // Today's gain must be a fraction of the total, never larger than it.
    for (const item of withMomentum) {
      expect(Number(item.signals.starsToday)).toBeLessThanOrEqual(Number(item.signals.stars));
    }
  });

  /**
   * A repo can be renamed. The numeric id is stable, the path is not, so
   * dedupe across runs has to key on the id.
   */
  it("uses the stable numeric repository id as externalId", async () => {
    const result = await fetchTrendingRepos({ fetchImpl: respond(FIXTURE), now: NOW });
    if (!result.ok) throw new Error("expected success");

    const ids = result.value.map((item) => item.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never assigns an arxivId, so repos cannot join the research cluster", async () => {
    const result = await fetchTrendingRepos({ fetchImpl: respond(FIXTURE), now: NOW });
    if (!result.ok) throw new Error("expected success");

    expect(result.value.every((item) => item.arxivId === null)).toBe(true);
  });

  /**
   * The page is unversioned markup. A restyle that yields no rows must fail
   * loudly — an empty success is indistinguishable from a quiet day, and would
   * silently drop this source from the feed.
   */
  it("errors rather than returning an empty list when the markup changes", async () => {
    const result = await fetchTrendingRepos({
      fetchImpl: respond("<html><body><p>redesigned</p></body></html>"),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("parse");
    expect(result.error.message).toMatch(/markup/i);
  });

  it("errors when rows exist but none can be parsed", async () => {
    const rows = '<article class="Box-row">nothing useful</article>'.repeat(3);
    const result = await fetchTrendingRepos({ fetchImpl: respond(rows), now: NOW });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/none could be parsed/);
  });

  it("reports an http failure as an error rather than throwing", async () => {
    const result = await fetchTrendingRepos({ fetchImpl: respond("nope", 503), now: NOW });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("http");
  });

  it("reports a network failure as an error rather than throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection reset");
    }) as typeof fetch;

    const result = await fetchTrendingRepos({ fetchImpl, now: NOW });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("network");
  });

  it("requests the window it was asked for", async () => {
    let requested = "";
    const fetchImpl = (async (url: string) => {
      requested = url;
      return new Response(FIXTURE, { status: 200 });
    }) as unknown as typeof fetch;

    await fetchTrendingRepos({ since: "weekly", fetchImpl, now: NOW });

    expect(requested).toContain("since=weekly");
  });

  /**
   * Trending is a claim about now. A repo created in 2014 that is spiking today
   * is a current event, so the fetch time is the honest timestamp — its
   * creation date would make the item look stale.
   */
  it("timestamps items with the fetch time, not repo creation", async () => {
    const result = await fetchTrendingRepos({ fetchImpl: respond(FIXTURE), now: NOW });
    if (!result.ok) throw new Error("expected success");

    expect(result.value.every((item) => item.publishedAt.getTime() === NOW.getTime())).toBe(true);
  });
});

describe("parseTrendingRow", () => {
  it("skips a row with no repository path", () => {
    expect(parseTrendingRow("<div>no repo here</div>", NOW)).toBeNull();
  });

  it("skips a row with a path but no stable id", () => {
    const row = '<h2 class="h3"><a href="/owner/name">owner / name</a></h2>';
    expect(parseTrendingRow(row, NOW)).toBeNull();
  });

  it("decodes entities in the description rather than passing markup through", () => {
    const row = `
      <h2 class="h3"><a href="/acme/tool">acme / tool</a></h2>
      repository_id&quot;:12345
      <p class="col-9 color-fg-muted my-1 pr-4">Fast &amp; small &quot;agent&quot; runtime</p>`;

    const item = parseTrendingRow(row, NOW);

    expect(item?.text).toBe('Fast & small "agent" runtime');
  });

  it("treats a missing description as null rather than an empty string", () => {
    const row = `
      <h2 class="h3"><a href="/acme/tool">acme / tool</a></h2>
      repository_id&quot;:12345`;

    expect(parseTrendingRow(row, NOW)?.text).toBeNull();
  });
});

/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fetchRecent, parseAtomFeed } from "@/lib/sources/arxiv";

const fixture = readFileSync(join(process.cwd(), "tests/fixtures/arxiv-recent.xml"), "utf-8");

describe("parseAtomFeed", () => {
  it("normalizes every entry in the fixture", () => {
    const result = parseAtomFeed(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeGreaterThanOrEqual(50);
    for (const item of result.value) {
      expect(item.kind).toBe("ARXIV");
      expect(item.externalId).not.toHaveLength(0);
      expect(item.title).not.toHaveLength(0);
      expect(item.publishedAt.getTime()).not.toBeNaN();
      expect(item.sourceUrl).toMatch(/^https:\/\/arxiv\.org\/abs\//);
    }
  });

  it("strips the newlines arXiv pads titles and abstracts with", () => {
    const result = parseAtomFeed(fixture);
    if (!result.ok) throw new Error("fixture failed to parse");

    for (const item of result.value) {
      expect(item.title).not.toMatch(/\s{2,}|\n/);
      if (item.text) expect(item.text).not.toMatch(/\s{2,}|\n/);
    }
  });

  it("handles a single-author entry, which the XML parser gives as an object not an array", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>http://arxiv.org/abs/2501.00001v1</id>
          <title>Solo Paper</title>
          <summary>An abstract.</summary>
          <published>2026-01-01T00:00:00Z</published>
          <author><name>Ada Lovelace</name></author>
        </entry>
      </feed>`;

    const result = parseAtomFeed(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value[0].authors).toEqual(["Ada Lovelace"]);
  });

  it("extracts a GitHub repo from the arXiv comment as a ranking signal", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
        <entry>
          <id>http://arxiv.org/abs/2501.00002v1</id>
          <title>Paper With Code</title>
          <published>2026-01-01T00:00:00Z</published>
          <arxiv:comment>Code at: https://github.com/example/repo</arxiv:comment>
        </entry>
      </feed>`;

    const result = parseAtomFeed(xml);
    if (!result.ok) throw new Error("failed to parse");

    expect(result.value[0].signals.repoUrl).toBe("https://github.com/example/repo");
  });

  it("returns a parse error rather than throwing on malformed XML", () => {
    const result = parseAtomFeed("not xml at all <<<>>>");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("parse");
  });

  it("returns an empty list for a feed with no entries", () => {
    const empty = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`;
    const result = parseAtomFeed(empty);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("skips entries missing required fields instead of failing the batch", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry><title>No id and no published date</title></entry>
        <entry>
          <id>http://arxiv.org/abs/2501.00003v1</id>
          <title>Valid Entry</title>
          <published>2026-01-01T00:00:00Z</published>
        </entry>
      </feed>`;

    const result = parseAtomFeed(xml);
    if (!result.ok) throw new Error("failed to parse");

    expect(result.value).toHaveLength(1);
    expect(result.value[0].title).toBe("Valid Entry");
  });
});

describe("fetchRecent", () => {
  it("returns an http error for a non-ok response", async () => {
    const fetchImpl = (async () =>
      new Response("upstream down", { status: 503 })) as unknown as typeof fetch;

    const result = await fetchRecent({ since: new Date(0), fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: "http", status: 503 });
  });

  it("returns a network error when the request itself throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await fetchRecent({ since: new Date(0), fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: "network", message: "ECONNREFUSED" });
  });

  it("filters out items published before `since`", async () => {
    const fetchImpl = (async () =>
      new Response(fixture, { status: 200 })) as unknown as typeof fetch;

    const future = new Date(Date.now() + 365 * 24 * 3_600_000);
    const result = await fetchRecent({ since: future, fetchImpl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

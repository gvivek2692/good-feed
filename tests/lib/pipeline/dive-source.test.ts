/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveQuotableSource, THIN_SOURCE_CHARS } from "@/lib/pipeline/dive-source";
import { err, ok } from "@/lib/result";

vi.mock("@/lib/sources/article", () => ({ fetchArticleText: vi.fn() }));

const { fetchArticleText } = await import("@/lib/sources/article");
const mockFetch = vi.mocked(fetchArticleText);

const thick = "x".repeat(THIN_SOURCE_CHARS);
const thin = "x".repeat(THIN_SOURCE_CHARS - 1);

describe("resolveQuotableSource", () => {
  afterEach(() => vi.resetAllMocks());

  it("returns text unchanged when it already clears the threshold", async () => {
    const result = await resolveQuotableSource(thick, "https://example.com/post");

    expect(result).toBe(thick);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches the linked page when the body is thin", async () => {
    const article = "y".repeat(5_000);
    mockFetch.mockResolvedValue(ok(article));

    expect(await resolveQuotableSource(thin, "https://example.com/post")).toBe(article);
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/post");
  });

  it("keeps the original text when the fetch fails", async () => {
    mockFetch.mockResolvedValue(err({ kind: "network", message: "timeout" }));

    expect(await resolveQuotableSource(thin, "https://example.com/post")).toBe(thin);
  });

  it("keeps the original text when the fetched page is shorter", async () => {
    mockFetch.mockResolvedValue(ok("short"));

    expect(await resolveQuotableSource(thin, "https://example.com/post")).toBe(thin);
  });

  it("does not fetch when there is no url", async () => {
    expect(await resolveQuotableSource(thin, null)).toBe(thin);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

/** @vitest-environment node */
import { describe, expect, it } from "vitest";

import { cleanMarkdown, extractText, fetchArticleText, toReadableUrl } from "@/lib/sources/article";

function respond(body: string, contentType = "text/html"): typeof fetch {
  return (async () =>
    new Response(body, { status: 200, headers: { "content-type": contentType } })) as typeof fetch;
}

describe("toReadableUrl", () => {
  /**
   * Measured on the post that surfaced this gap: the GitHub blob page is 396KB
   * of application chrome, the raw URL is the same content as 24KB of markdown.
   */
  it("rewrites a GitHub blob url to raw content", () => {
    expect(toReadableUrl("https://github.com/humanlayer/agents/blob/main/benchmarking.md")).toBe(
      "https://raw.githubusercontent.com/humanlayer/agents/main/benchmarking.md",
    );
  });

  it("prefers an arXiv abstract page over a pdf link", () => {
    expect(toReadableUrl("https://arxiv.org/pdf/2607.12345")).toBe(
      "https://arxiv.org/abs/2607.12345",
    );
    expect(toReadableUrl("https://arxiv.org/pdf/2607.12345v2.pdf")).toBe(
      "https://arxiv.org/abs/2607.12345",
    );
  });

  it("leaves an ordinary url alone", () => {
    expect(toReadableUrl("https://example.com/post")).toBe("https://example.com/post");
  });
});

describe("extractText", () => {
  it("drops scripts, styles, and navigation chrome", () => {
    const html = `<html><head><style>.a{color:red}</style></head><body>
      <nav>Home About</nav><script>alert(1)</script>
      <p>The actual content of the article.</p><footer>Copyright</footer></body></html>`;

    const text = extractText(html);

    expect(text).toContain("The actual content");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("Copyright");
    expect(text).not.toContain("Home About");
  });

  it("prefers the article element when the page has one", () => {
    const html = `<body><div>sidebar junk</div><article><p>Real body text here.</p></article></body>`;
    const text = extractText(html);

    expect(text).toContain("Real body text");
    expect(text).not.toContain("sidebar junk");
  });

  it("decodes entities so quotes can still be matched against source text", () => {
    expect(extractText("<p>it&#39;s 40&amp;more &quot;fast&quot;</p>")).toContain(
      `it's 40&more "fast"`,
    );
  });

  it("keeps paragraph breaks rather than running text together", () => {
    expect(extractText("<p>First para.</p><p>Second para.</p>")).toBe("First para.\nSecond para.");
  });
});

describe("cleanMarkdown", () => {
  it("keeps link text while dropping urls and images", () => {
    const md = "See [the paper](https://example.com/x) ![chart](img/a.png) for detail.";
    const cleaned = cleanMarkdown(md);

    expect(cleaned).toContain("See the paper");
    expect(cleaned).not.toContain("https://example.com/x");
    expect(cleaned).not.toContain("img/a.png");
  });

  it("replaces code blocks rather than feeding them to the model verbatim", () => {
    const cleaned = cleanMarkdown("Intro\n\n```ts\nconst x = 1;\n```\n\nOutro");

    expect(cleaned).not.toContain("const x = 1");
    expect(cleaned).toContain("[code block]");
    expect(cleaned).toContain("Outro");
  });

  it("strips frontmatter", () => {
    expect(cleanMarkdown("---\ntitle: X\n---\nBody text.")).toBe("Body text.");
  });

  it("preserves headings, which carry the document's structure", () => {
    expect(cleanMarkdown("# Title\n\n## Section\n\nText.")).toContain("## Section");
  });
});

describe("fetchArticleText", () => {
  it("returns extracted text for an html page", async () => {
    const body = `<article><p>${"Real article sentence. ".repeat(20)}</p></article>`;
    const result = await fetchArticleText("https://example.com/post", {
      fetchImpl: respond(body),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain("Real article sentence");
  });

  it("treats a .md url as markdown rather than html", async () => {
    const md = `# Title\n\n${"A sentence about the benchmark. ".repeat(20)}`;
    const result = await fetchArticleText("https://raw.githubusercontent.com/a/b/main/x.md", {
      fetchImpl: respond(md, "text/plain"),
    });

    if (!result.ok) throw new Error("expected success");
    expect(result.value).toContain("# Title");
  });

  it("reports an http error rather than throwing", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    const result = await fetchArticleText("https://example.com/missing", { fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("http");
  });

  it("rejects a non-text document instead of feeding bytes to the model", async () => {
    const result = await fetchArticleText("https://example.com/a.pdf", {
      fetchImpl: respond("%PDF-1.4", "application/pdf"),
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a page with too little readable text to be worth summarizing", async () => {
    const result = await fetchArticleText("https://example.com/thin", {
      fetchImpl: respond("<p>Hi.</p>"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("too little");
  });

  /**
   * The URL comes from a third-party feed, so it is untrusted input. Fetching a
   * private address on its say-so is server-side request forgery.
   */
  it("refuses to fetch a private or loopback address", async () => {
    for (const url of [
      "http://localhost:3000/admin",
      "http://127.0.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://172.16.0.1/",
    ]) {
      const result = await fetchArticleText(url, { fetchImpl: respond("<p>secret</p>") });
      expect(result.ok).toBe(false);
    }
  });

  it("refuses a non-http protocol", async () => {
    const result = await fetchArticleText("file:///etc/passwd", {
      fetchImpl: respond("root:x:0:0"),
    });

    expect(result.ok).toBe(false);
  });

  it("reports a network failure as an error rather than throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;

    const result = await fetchArticleText("https://example.com/x", { fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("network");
  });
});

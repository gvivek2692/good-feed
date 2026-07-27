# good-feed

A personalized AI news feed for AI engineers. Turns scattered developments across arXiv and Hacker
News into short summaries — each stating what the item is **and why it matters** — ranked by
importance rather than recency.

> **Status:** Pre-implementation. Intent and spec are confirmed; no application code yet.

## What it is

Information about AI research and engineering is scattered, and reading full papers costs more time
than most items are worth. good-feed produces the central ideas with links to explore further.

Each item is a hub with three exits: the full source, related items, or a longer explanation.

**What it is not:** it does not tell you what to *do* with what you read. It has opinions about the
field, not about your work.

## Design commitments

Two decisions carry the product:

**Ranking by judged importance, not recency.** v1 ranks purely on observable signals — cross-source
coverage, discussion velocity, repo momentum, recency decay. No LLM scoring in the ordering path.
Every score stores the numbers behind it, so the feed can always answer "why is this item here?"

**Takes must be grounded.** A summary that misrepresents its source is worse than no summary, because
the whole value is not having to check. Comparative claims ("outperforms X", "supersedes Y") must map
to quoted source text with a citation, enforced by schema validation rather than prompting.
Unsupported assertions are stripped before publication.

A quiet week produces a short feed. The feed is never padded to hit a quota.

## Documentation

| Document | Purpose |
|---|---|
| [docs/intent/good-feed.md](docs/intent/good-feed.md) | Confirmed intent — what and why |
| [docs/spec/good-feed-v1.md](docs/spec/good-feed-v1.md) | Full v1 specification |
| [tasks/plan.md](tasks/plan.md) | Implementation plan and dependency graph |
| [tasks/todo.md](tasks/todo.md) | 18 tasks with acceptance criteria |

## Stack

Next.js 15 (App Router) · TypeScript · Postgres + pgvector · Prisma · Gemini · Auth.js ·
Tailwind · Vitest · Playwright

## Getting started

Not yet runnable — implementation begins at Task 1. Once scaffolded:

```bash
npm install
cp .env.example .env.local   # fill in your own keys; never commit this file
npx prisma migrate dev
npm run dev
```

## License

MIT — see [LICENSE](LICENSE).

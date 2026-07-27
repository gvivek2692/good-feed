<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# good-feed — project conventions

**Read first:** [docs/intent/good-feed.md](docs/intent/good-feed.md) ·
[docs/spec/good-feed-v1.md](docs/spec/good-feed-v1.md) · [tasks/todo.md](tasks/todo.md)

Next.js 16.2 · React 19.2 · TypeScript 5 · Tailwind 4 · Vitest 4 · Playwright.
Next 16 diverges from older App Router patterns — consult the bundled docs above rather than
recalling conventions.

## Commands

```
npm run dev          npm test            npm run lint
npm run build        npm run test:e2e    npm run typecheck
npm run format       npm run format:check
```

Before any commit: `npm test && npm run typecheck && npm run lint`.

## Code style

- Named exports only, except Next.js pages/layouts where the framework requires default.
- Explicit return types on module boundaries.
- Zod schemas validate **all** external data — source APIs and LLM responses alike.
- Errors are values at boundaries (`Result<T, E>`), not thrown control flow.
- `camelCase` functions/variables · `PascalCase` types/components · `kebab-case` files.

## Layout

```
src/lib/sources/    One adapter per content source
src/lib/pipeline/   Ingest → dedupe → cluster → summarize → validate → rank
src/lib/ranking/    Signal scoring (no LLM involvement)
src/lib/llm/        Gemini client, prompts, schemas, pinned model IDs
tests/              Vitest, mirrors src/
e2e/                Playwright
```

## Non-negotiable rules

These come from the spec's Boundaries section. They are not stylistic.

**Never:**
- Commit secrets. Keys live in `.env` (gitignored); `.env.example` names variables only.
- Let an unsupported assertion reach the UI — every comparative claim maps to quoted source text.
- Use absolute LLM scoring for ranking (produces confident, unfalsifiable numbers).
- Rank purely by recency.
- Pad the feed to hit an item count. A quiet week produces a short feed.
- Remove failing tests to make a build pass.

**Ask first:** new content sources · `Item`/`Claim` schema changes · new dependencies · anything
that tells users what to *do* with an item (out of scope by design) · starting phase-2 comparative
reranking.

## Verified environment facts

Confirmed by live API call on 2026-07-27, not assumed:

- `gemini-embedding-001` returns **3072 dimensions** by default. pgvector's HNSW/IVFFlat indexes cap
  at 2000, so either request a reduced `outputDimensionality` (1536 recommended) or accept unindexed
  similarity search.
- Gemini 3.x flash models **think by default** — a 5-token prompt cost 126 total tokens, 120 of them
  thinking. Pin a thinking budget explicitly for per-item pipeline calls.
- Available and current: `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-embedding-001`.
  Re-verify model IDs against the live API rather than trusting these to stay current.

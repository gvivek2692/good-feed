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
docker compose up -d              start local Postgres (port 5433)
npm run dev          npm test            npm run lint
npm run build        npm run test:e2e    npm run typecheck
npm run format       npm run format:check
npx prisma migrate dev            apply migrations
npx prisma generate               regenerate client (not automatic on migrate)
npx tsx prisma/seed.ts            seed topics (idempotent)
```

Before any commit: `npm test && npm run typecheck && npm run lint`.

## Database

Local Postgres runs on **5433**, not 5432 — that port belongs to an unrelated
`smartmoney-postgres` container on this machine.

Prisma 7 differs from earlier versions in ways that matter:

- `PrismaClient` requires an explicit **driver adapter** (`@prisma/adapter-pg`); it no longer
  reads `DATABASE_URL` itself. Always import the shared client from `src/lib/db/client.ts`.
- Seeding is configured in `prisma.config.ts`, not `package.json`.
- `prisma migrate dev` does **not** regenerate the client — run `prisma generate` separately.
- Vitest 4 removed `environmentMatchGlobs`. Server-side tests declare
  `@vitest-environment node` in a file-level docblock instead.

## Auth and per-user state

Auth.js v5 (`next-auth@beta`) with GitHub OAuth, database sessions via
`@auth/prisma-adapter`. Requires `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`.

- **Next 16 renamed `middleware` to `proxy`.** `middleware.ts` is deprecated; the file is
  `proxy.ts` and the named export is `proxy`. The `edge` runtime is not supported there.
- **Authorization belongs in the data access layer, not proxy.** Proxy runs on every request
  including prefetches, so a DB check there is slow and — a cookie can exist without a valid
  session — not trustworthy alone. `src/lib/auth/session.ts` wraps the session lookup in React's
  `cache()` so several Server Components share one lookup per render.
- **Server actions are public HTTP endpoints.** The user id always comes from the session, never
  from an argument — a `userId` parameter would let any caller write rows for any user. Verified by
  a mutation test: removing the guard in `src/app/actions/interactions.ts` fails 2 tests.
- **`Interaction` is idempotent by constraint**, `@@unique([userId, itemId, kind])`. Clearing an
  absent interaction uses `deleteMany` — the requested end state, not a failure.
- **Postgres timestamps can collide.** Two consecutive inserts measurably share a millisecond, so
  ordering tests set `at` explicitly rather than relying on insertion order.

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
- Commit secrets. Keys live in `.env.local` (gitignored); `.env.example` names variables only.
  Scripts, Prisma, and Vitest reach it through `src/lib/env.ts` — `dotenv/config` alone reads only
  `.env`, and without `DATABASE_URL` the integration tests skip themselves while the suite still
  reports green.
- Let an unsupported assertion reach the UI — every comparative claim maps to quoted source text.
- Use absolute LLM scoring for ranking (produces confident, unfalsifiable numbers).
- Rank purely by recency.
- Pad the feed to hit an item count. A quiet week produces a short feed.
- Remove failing tests to make a build pass.

**Ask first:** new content sources · `Item`/`Claim` schema changes · new dependencies · anything
that tells users what to *do* with an item (out of scope by design) · starting phase-2 comparative
reranking.

## Sources and the two-cluster model

Three sources, forming **two clusters that share no items** — measured, see
[ADR 001](docs/adr/001-source-selection-and-cross-source-joins.md):

- **Research cluster:** arXiv + HuggingFace Papers, joined on version-stripped `arxivId`.
  91 real pairs in the fixtures (37% of HF papers).
- **Discussion cluster:** Hacker News, standalone. Measured **zero** joins to either paper source
  via three independent strategies. HN items never cluster with papers and can never carry a
  cross-source coverage signal — ranking must not assume otherwise.

HuggingFace Papers is a **curated funnel** (~17 papers/day vs arXiv's ~143), so absence from HF is
not evidence a paper is unimportant. Papers with Code is **dead** — its API 302s to HuggingFace.

## Source API behaviors

Established by live calls during Task 3:

- **HuggingFace `daily_papers` is day-scoped** — one request per day, no range parameter. A paper
  recurs across days while trending; keep the highest-upvote snapshot.

- **Algolia (HN) does not support boolean `OR` in `query`.** It treats `"AI OR LLM"` as a phrase and
  matches titles literally containing "AI or LLM" — near-zero results. Each term must be a separate
  request, merged and deduped by `objectID`. `src/lib/sources/hackernews.ts` does this.
- **HN link posts have no body text.** `story_text` is empty for anything that is a link rather than
  an Ask/Show post — the real content is at `url`. Without fetching it the pipeline sees only a
  title, which produced a 40-word deep dive that explained nothing.
  `src/lib/sources/article.ts` fetches that one page on demand.
- **A GitHub blob URL returns 396KB of page chrome; the `raw.githubusercontent.com` rewrite returns
  24KB of clean markdown.** Measured on the same post. Always rewrite before fetching.
- **arXiv requires HTTPS.** `http://export.arxiv.org` returns an empty body rather than redirecting.
- **arXiv has no server-side date filter.** Sort by `submittedDate` descending and trim client-side.
- **fast-xml-parser collapses single repeated elements to objects.** A one-author paper yields
  `author: {name}`, not `author: [{name}]`. Always normalize through `toArray`.
- **arXiv abstracts are raw LaTeX.** They contain `\%`, `\textsc{...}`, and `$...$`. An LLM quoting
  an abstract quotes the *rendered* form (`72.5%`), so verbatim quote matching must unwrap LaTeX
  escaping or it rejects genuinely grounded claims — measured, not hypothetical. See
  `normalize()` in `src/lib/pipeline/claims.ts`.
- Fixtures live in `tests/fixtures/`. The unit suite runs entirely offline against them; live checks
  go in `scripts/check-sources.mts`, which is not part of `npm test`.

## Gemini API behaviors

Verified by live call on 2026-07-27 during Task 5. Model ids are pinned in `src/lib/llm/models.ts`.

- **Gemini 3.x flash cannot disable thinking.** `thinkingBudget: 0` is rejected as an invalid
  argument. Measured: an unconstrained 5-token prompt spent **263** thinking tokens; at
  `thinkingBudget: 128` it spends ~54. Always set the budget explicitly for per-item pipeline calls —
  at feed volume this is the dominant cost.
- **`thinkingLevel: "high"` exists** but exhausted the free-tier quota immediately. Use
  `thinkingBudget` instead.
- **Free-tier quota on `gemini-3.6-flash` is easily exhausted** by a handful of calls.
  `gemini-3.5-flash-lite` has more headroom, which is why live check scripts use it.
- **Structured output works** via `responseMimeType: "application/json"` + `responseSchema`, and
  combines with `thinkingConfig`. Validate with Zod anyway — the API constraint is not a guarantee
  against truncated or empty responses.
- **`gemini-embedding-001` honours `outputDimensionality: 1536`**, down from its 3072 default.
  Required: pgvector's HNSW/IVFFlat indexes cap at 2000 dimensions.
- **Free-tier quota does not survive an ingest run.** First live end-to-end run (2026-07-27, 22
  items fetched, 11 clearing the floor): **8 of 11 summarization calls failed with `rateLimit`**,
  3 published, in 48s. This is spec open question 1 — the free tier cannot sustain even a
  single-digit batch. Real ingest needs a paid tier, batching with delays, or both. Retry with
  backoff is necessary but not sufficient at this quota.
- **Self-reported confidence is not calibrated.** Measured over 37 topic assignments: 7 distinct
  values on a 0.05 grid, min 0.60, 34/37 at ≥0.80. A confidence threshold filters nothing at these
  values — treat it as a floor against explicit low-confidence output, not as a probability, and do
  not tune it upward just to make it reject something.
- **`*-latest` aliases are deliberately unused.** A model changing underneath the pipeline would
  silently change summaries and takes, which the trust constraint cannot tolerate.

## Verified environment facts

Confirmed by live API call on 2026-07-27, not assumed:

- `gemini-embedding-001` returns **3072 dimensions** by default. pgvector's HNSW/IVFFlat indexes cap
  at 2000, so either request a reduced `outputDimensionality` (1536 recommended) or accept unindexed
  similarity search.
- Gemini 3.x flash models **think by default** — a 5-token prompt cost 126 total tokens, 120 of them
  thinking. Pin a thinking budget explicitly for per-item pipeline calls.
- Available and current: `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-embedding-001`.
  Re-verify model IDs against the live API rather than trusting these to stay current.

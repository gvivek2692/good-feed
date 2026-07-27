# Spec: good-feed v1

**Status:** Draft, awaiting review. Implements [docs/intent/good-feed.md](../intent/good-feed.md).
**Date:** 2026-07-27

---

## Objective

A web app that turns scattered AI research and engineering developments into short, opinionated
summaries. Each item states what it is *and why it matters*, and acts as a hub with three exits:
the full source, related items, or a longer explanation.

**User:** AI engineers, each setting topic interests so the feed matches their subfield.
Vivek is user zero.

**Success:** A user opens the app, spends a few minutes, and leaves knowing what happened in their
areas and which parts were significant — without opening a single paper. They come back.

**Binding constraint:** Summaries must be trustworthy, *including the judgment calls*. An item
wrongly claiming something "supersedes X" is worse than no summary at all.

### User stories

1. As an AI engineer, I select topics I care about (e.g. inference optimization, agents, RAG) so my
   feed is scoped to my subfield.
2. As a user, I skim a feed of short summaries ordered by importance, not recency, so the most
   significant developments are at the top.
3. As a user, I read a one-paragraph "why this matters" on any item so I understand its significance
   without opening the source.
4. As a user, I click through to the original source, related items, or a longer explanation.
5. As a user, I dismiss items I've seen so they don't reappear.

---

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Framework | Next.js 15 (App Router), TypeScript | UI + API in one deploy |
| Database | Postgres 16 + pgvector | Relational core; embeddings for "related items" |
| ORM | Prisma | Typed schema, migrations |
| LLM | Gemini (`@google/genai` SDK) | Chosen by Vivek; serves both chat and embeddings, so one provider covers the whole pipeline |
| Auth | Auth.js — GitHub OAuth | Minimal; not the interesting part |
| Styling | Tailwind CSS | Fast, no design system needed at v1 |
| Jobs | Vercel Cron → API route | No separate worker infra at v1 |
| Testing | Vitest (unit/integration), Playwright (e2e) | Standard, fast |
| Hosting | Vercel + Neon Postgres | Cheapest path to a real URL |

**Sources v1:** arXiv API, Hacker News (Algolia API). Both free, no scraping, no auth.
X/Twitter and individual blogs are explicitly deferred — X costs money, blogs need per-site parsers.

**LLM access:** Google's `@google/genai` SDK. The key is read from `GEMINI_API_KEY` in the
environment and must never appear in source, spec, or committed config. `.env*` is gitignored;
`.env.example` lists the variable name only.

Gemini serves both generation and embeddings, so one provider and one key cover the whole pipeline:

- **Summaries, takes, topic classification, deep-dive expansion** — a fast Gemini Flash-tier model.
  These are high-volume, per-item calls where latency and cost matter more than peak reasoning.
- **Embeddings** — Gemini's embedding endpoint, called at ingest time to populate `Item.embedding`
  for "related items". No separate embeddings provider and no local inference on serverless.

Exact model IDs are pinned in `lib/llm/models.ts` and verified against current Google documentation
at implementation time rather than hardcoded from memory here — model naming moves fast enough that
a spec-time guess would likely be stale. All provider access stays behind `lib/llm/`, so a future
provider swap touches one directory.

---

## Commands

```
Install:   npm install
Dev:       npm run dev
Build:     npm run build
Test:      npm test
Test (watch): npm test -- --watch
Coverage:  npm test -- --coverage
E2E:       npm run test:e2e
Lint:      npm run lint
Lint fix:  npm run lint -- --fix
Typecheck: npm run typecheck
DB migrate: npx prisma migrate dev
DB studio:  npx prisma studio
Ingest (manual): npm run ingest
```

---

## Project Structure

```
src/
  app/                  → Next.js App Router pages and API routes
    (feed)/             → Authenticated feed UI
    api/
      cron/ingest/      → Scheduled ingestion entrypoint
  components/           → React components
  lib/
    sources/            → One adapter per source (arxiv.ts, hackernews.ts)
    pipeline/           → Ingest → dedupe → score → summarize stages
    ranking/            → Signal scoring; comparative reranker (phase 2)
    llm/                → Claude client, prompts, response schemas
    db/                 → Prisma client, queries
tests/                  → Unit and integration tests (mirrors src/)
e2e/                    → Playwright end-to-end tests
docs/
  intent/               → Confirmed intent (upstream of this spec)
  spec/                 → This document
  adr/                  → Architecture decision records
tasks/                  → plan.md, todo.md
prisma/                 → schema.prisma, migrations
```

---

## Data Model (core entities)

```
Source        id, kind (arxiv|hackernews), externalId, url, rawPayload, fetchedAt
Item          id, sourceId, title, authors, publishedAt, canonicalUrl,
              summary, whyItMatters, embedding(vector), importanceScore,
              signalSnapshot(jsonb), clusterId
Claim         id, itemId, text, quotedFrom, sourceUrl   ← grounding for takes
Topic         id, slug, label
ItemTopic     itemId, topicId, confidence
User          id, email, githubId, createdAt
UserTopic     userId, topicId
Interaction   userId, itemId, kind (seen|dismissed|opened|deepened), at
```

`clusterId` groups items that cover the same underlying development (a paper + its HN thread +
its GitHub repo) — cross-source coverage count is a ranking signal and prevents duplicate feed slots.

---

## Ranking (the core design problem)

Ranking by *judged importance* is the reason to build this rather than use TLDR AI or AlphaSignal.
It gets built in two phases, and **phase 1 ships alone**.

### Phase 1 — Signal-based (v1 scope)

Ordering is computed from observable evidence only. No LLM involvement in the ordering.

| Signal | Source | Notes |
|---|---|---|
| Cross-source coverage | Count of distinct sources in cluster | Strongest signal available |
| HN points + comment velocity | HN API | Normalized against trailing 30-day distribution |
| GitHub stars velocity | GH API, when repo linked | Delta, not absolute |
| arXiv listing prominence | arXiv | Weak; used as tiebreak |
| Author prior prominence | Derived from historical items | Deferred if it gets complicated |
| Recency decay | Computed | Multiplier, not a primary term |

Every score is stored in `signalSnapshot` so any ordering can be explained after the fact.
**Requirement: the feed can always answer "why is this item here?" with numbers.**

### Phase 2 — Comparative reranking (deferred, not v1)

Signals produce a shortlist; Claude orders the shortlist *comparatively* (pairwise/listwise within a
batch), never by absolute score. Absolute 1–10 scoring is explicitly rejected: it produces confident,
unfalsifiable numbers that cluster at 6–8 and make ranking arbitrary while looking principled.

Phase 2 only begins once phase 1 has run long enough to show where it fails.

---

## Trust: grounding the takes

The `whyItMatters` take is the highest-risk output in the product.

**Rule: the take may only assert what the source itself claims.**

- Every comparative or superlative assertion ("outperforms X", "supersedes Y", "first to Z") must map
  to a `Claim` row with the quoted source text and a URL.
- The UI renders these as visible citations on the take.
- The model may summarize, contextualize, and identify who should care. It may **not** independently
  declare something obsolete, state a result the source doesn't state, or compare to work the source
  doesn't reference.
- Unsupported assertions are stripped in a validation pass before an item can be published.

This is enforced in code (schema validation on the LLM response), not just in the prompt.

---

## Code Style

Named exports, explicit return types on module boundaries, Zod schemas for all external data
(API responses and LLM output alike). Errors are values at boundaries, not thrown control flow.

```ts
import { z } from "zod";

const ArxivEntry = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  published: z.coerce.date(),
  authors: z.array(z.string()),
});

export type ArxivEntry = z.infer<typeof ArxivEntry>;

export async function fetchRecent(
  category: string,
  since: Date,
): Promise<Result<ArxivEntry[], SourceError>> {
  const res = await fetch(buildQuery(category, since));
  if (!res.ok) return err({ kind: "http", status: res.status });
  return ok(ArxivEntry.array().parse(await parseAtom(res)));
}
```

Conventions: `camelCase` functions/variables, `PascalCase` types/components, `kebab-case` files.
No default exports except Next.js pages/layouts where the framework requires them.

---

## Testing Strategy

| Level | Framework | Location | Covers |
|---|---|---|---|
| Unit | Vitest | `tests/` mirroring `src/` | Source adapters, ranking math, claim validation |
| Integration | Vitest + test DB | `tests/integration/` | Pipeline stages against real Postgres |
| E2E | Playwright | `e2e/` | Sign in → set topics → read feed → dismiss |

**Non-negotiable coverage:**
- Ranking math: unit tested with fixture items and asserted orderings.
- Claim validation: unit tested that unsupported assertions are stripped. This is the trust
  constraint; it gets tests before it gets a UI.
- Source adapters: tested against recorded fixtures, not live APIs.

LLM calls are mocked in all tests except a small, separately-run suite of live evaluation cases.

---

## Observability (the code loop stays visible)

Per [good-feed-automation-is-the-point], the content loop should be boring and unattended, but
agent-driven work on this codebase stays inspectable. For v1 this means:

- Every pipeline run writes a structured run log: items fetched, deduped, scored, published, dropped.
- Every dropped item records *why* it was dropped (dedupe, validation failure, below cutoff).
- An internal `/admin/runs` page renders recent runs. Not a user feature; a debugging surface.

---

## Boundaries

**Always:**
- Run `npm test` and `npm run typecheck` before committing.
- Validate all external data (source APIs, LLM responses) through Zod at the boundary.
- Store the signal snapshot behind every ranking decision.
- Write a test for ranking or claim-validation changes before the change.

**Ask first:**
- Adding a new content source.
- Schema changes to `Item` or `Claim`.
- Adding dependencies.
- Anything that moves scope toward option C (telling users what to *do*) — see intent doc.
- Starting phase-2 comparative reranking.

**Never:**
- Commit API keys or `.env`. Keys live in the environment only — never in source, spec, or docs.
- Let an unsupported assertion reach the UI.
- Use absolute LLM scoring for ranking.
- Rank purely by recency.
- Pad the feed to hit an item count when few items clear the cutoff.
- Remove failing tests to make a build pass.

---

## Success Criteria

Specific and testable:

1. A signed-in user with ≥1 topic selected sees a feed of ≥10 items ordered by `importanceScore`,
   not `publishedAt`.
2. Every item shows: title, ≤120-word summary, a "why this matters" take, and source attribution.
3. Every comparative assertion in a take has a visible citation linking to the quoted source.
4. `npm test` passes with ranking and claim-validation suites green.
5. Ingestion runs on schedule, is idempotent, and re-running produces no duplicate items.
6. Each item offers three exits: source, related items, dig deeper.
7. Dismissed items do not reappear for that user.
8. `/admin/runs` explains, for any item in the feed, why it ranked where it did.
9. E2E: sign in → select topics → read feed → dismiss → refresh → dismissed item is absent.
10. A user with 3–5 topics sees 15–25 items/day at the default cutoff; a week with little activity
    produces a correspondingly short feed rather than padded filler.
11. No secret appears in the repository: `.env*` is gitignored and `.env.example` names variables
    without values.

---

## Resolved Decisions

These were open questions in the draft. Vivek delegated them; each is decided below with its
reasoning, and each is revisitable if the reasoning turns out wrong.

### 1. "Dig deeper" = one longer generated explanation

A single expansion of the same item: ~500 words, assumes the summary was read, goes into method and
result detail. Generated on demand and cached, not pre-generated for every item (most are never
expanded — pre-generating burns tokens on items nobody opens).

*Why:* Anything richer — tutorial, implementation guide, worked example — is a different product and
starts pulling toward option C. The expansion is bound by the same claim-grounding rules as the take.

### 2. Cold start: pure signal ranking, plus explicit topic selection at signup

A new user picks topics before seeing a feed; that plus signal ranking is the whole cold-start story.
No interaction-history personalization in v1.

*Why:* Signal ranking is user-independent by construction, so a new user's feed is exactly as good as
an established user's. Personalization from behavior is a phase-2 concern that needs data this
product does not yet have.

### 3. Feed cadence: "since last visit", 7-day fallback, 30-day ceiling

The feed shows items published since the user's last visit. First visit or a gap over 30 days falls
back to the trailing 7 days. Recency decay uses a 14-day half-life within whatever window applies.

*Why:* "Since last visit" matches the actual job — *what did I miss* — and degrades gracefully for
irregular users. The 30-day ceiling stops a returning user from being handed 400 items.

### 4. Topic taxonomy: fixed curated list, ~15 topics

Hand-authored slugs, e.g. `llm-training`, `inference-optimization`, `agents`, `rag`, `evaluation`,
`multimodal`, `reasoning`, `alignment-safety`, `hardware-systems`, `open-models`, `robotics`,
`speech-audio`, `vision`, `data-curation`, `tooling-infra`. Items get topics via LLM classification
with confidence, stored in `ItemTopic`.

*Why:* A derived taxonomy from clustering is a research project with no user-visible payoff at v1.
Fixed topics are legible to users at signup, which matters more than coverage. Revisit when the list
demonstrably fails to cover what shows up.

### 5. Volume target: 15–25 items/day at the default cutoff

Score cutoff is calibrated to yield roughly 15–25 items/day for a user with 3–5 topics selected. The
cutoff is a tunable constant, not a hardcoded number of items — a genuinely quiet week should produce
a short feed rather than padding to hit a quota.

*Why:* This is the spec's weakest decision and it should be flagged as such. The intent's success
criterion is "a few minutes, then leave informed," which at ~10s of skim per item puts the ceiling
near 25. Below ~10/day the signal math is too coarse to be trusted for that much selectivity —
cutting to 5/day would require the phase-2 comparative reranker. So: 15–25 now, and *if the feed
feels noisy, that is the evidence that phase 2 is needed* — not a reason to hand-tune the cutoff
downward.

**Explicitly not padded:** if fewer than 10 items clear the cutoff, the feed shows fewer than 10
items. A quiet week should look quiet. This is the anti-aggregator guard.

---

## Remaining Open Questions

1. **Gemini rate limits at ingest volume.** Unknown for this account tier, and free-tier quotas are
   materially tighter than paid. The pipeline must handle 429s with backoff and partial-batch resume
   regardless of tier, so this affects scheduling cadence rather than architecture. Measure during
   the first real ingest run.
2. **Ingestion runtime on Vercel.** A batch that summarizes, classifies, and embeds many items may
   exceed serverless execution limits. Mitigation is chunked runs with resumable state — the pipeline
   is built to resume from partial completion from the start, so this is a tuning problem rather than
   a redesign.

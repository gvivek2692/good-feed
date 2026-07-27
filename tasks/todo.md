# Tasks: good-feed v1

**Plan:** [tasks/plan.md](plan.md) · **Spec:** [docs/spec/good-feed-v1.md](../docs/spec/good-feed-v1.md)

Every task clears the Definition of Done: tests pass, no regressions, behavior verified, docs updated.

---

## Phase 1: Foundation

### Task 1: Scaffold project and tooling

**Description:** Initialize Next.js 15 (App Router) + TypeScript + Tailwind, configure Vitest,
Playwright, ESLint, Prettier. `git init` with a first commit. Create `.env.example` naming
`GEMINI_API_KEY`, `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` — values
never committed.

**Acceptance criteria:**
- [ ] `npm run dev`, `npm run build`, `npm test`, `npm run lint`, `npm run typecheck` all succeed
- [ ] `.gitignore` covers `.env*` (except `.env.example`), `node_modules`, `.next`
- [ ] One placeholder test passes, proving the runner works

**Verification:** `npm run build && npm test && npm run typecheck`

**Dependencies:** None · **Scope:** M

---

### Task 2: Prisma schema and first migration

**Description:** Implement the spec's data model — `Source`, `Item`, `Claim`, `Topic`, `ItemTopic`,
`User`, `UserTopic`, `Interaction`. Enable pgvector for `Item.embedding`. Seed the ~15 fixed topics.

**Acceptance criteria:**
- [ ] `npx prisma migrate dev` applies cleanly to a fresh database
- [ ] pgvector extension enabled; `Item.embedding` is a vector column
- [ ] Seed script inserts the 15 topics idempotently
- [ ] Unique constraint on `(sourceKind, externalId)` prevents duplicate ingestion

**Verification:** Migrate against a scratch DB, run seed twice, confirm 15 topics and no duplicates.

**Dependencies:** T1 · **Scope:** M

---

### Task 3: Source adapters + recorded fixtures

**Description:** `lib/sources/arxiv.ts` and `lib/sources/hackernews.ts`, each fetching recent items
and normalizing to a common shape behind a Zod schema. Capture a real response from each into
`tests/fixtures/` so all later work develops offline.

**Acceptance criteria:**
- [ ] Each adapter returns `Result<NormalizedItem[], SourceError>` — no thrown control flow
- [ ] Malformed/partial responses produce an error value, not a crash
- [ ] Fixtures committed: ≥50 arXiv entries, ≥50 HN stories
- [ ] Unit tests run against fixtures, never live APIs

**Verification:** `npm test -- sources`

**Dependencies:** T2 · **Scope:** M

---

### ✅ Checkpoint A
- [ ] Build, tests, lint, typecheck all green
- [ ] Migration applies to a fresh DB
- [ ] Fixtures captured and committed
- [ ] Human review before Phase 2

---

## Phase 2: The risky core

> Built and tested **before any UI**. If ranking or grounding fails, it fails cheaply here.

### Task 4: Clustering and dedupe

**Description:** Group items covering the same underlying development (paper + HN thread + repo) into
a `clusterId`. Start with lexical matching — normalized title similarity, shared canonical URLs,
arXiv ID extracted from HN links. Measure precision against hand-labeled fixtures.

**Acceptance criteria:**
- [ ] An arXiv paper and its HN submission land in one cluster
- [ ] Distinct papers by the same authors stay separate
- [ ] Hand-labeled fixture set (≥20 known pairs) with asserted cluster assignments
- [ ] Precision favored over recall — a bad merge hides an item, a missed dupe only costs a slot

**Verification:** `npm test -- clustering`

**Dependencies:** T3 · **Scope:** M

**Note:** If lexical precision is poor, this gains a dependency on T11 (embeddings) and both move
earlier. Decide by measurement.

---

### Task 5: Gemini client wrapper

**Description:** `lib/llm/` — client, pinned model IDs in `models.ts`, structured-output helper with
Zod validation, retry with exponential backoff on 429/5xx. **Verify current model IDs against live
Google documentation during this task; do not hardcode from memory.**

**Acceptance criteria:**
- [ ] Model IDs verified against current docs and pinned in one file
- [ ] All calls return typed, Zod-validated results
- [ ] 429 triggers backoff and retry; exhausted retries return an error value
- [ ] Key read from `GEMINI_API_KEY`; absent key fails with a clear message at startup
- [ ] Tests mock the transport — no live calls in the default suite

**Verification:** `npm test -- llm`

**Dependencies:** T2 · **Scope:** M

---

### Task 6: Summary, take, and claim extraction

**Description:** Given a clustered item, produce a ≤120-word summary, a "why this matters" take, and
a structured list of `Claim` objects. Every comparative or superlative assertion in the take must
appear as a claim carrying quoted source text and a URL.

**Acceptance criteria:**
- [ ] Output validated against a Zod schema; malformed responses retry then fail the item, never
      persist partial data
- [ ] Claims carry `text`, `quotedFrom`, `sourceUrl`
- [ ] Summary respects the word ceiling
- [ ] Prompt instructs the model to omit rather than invent when the source supports no claim

**Verification:** `npm test -- summarize` with mocked responses, including a deliberately
ungrounded response.

**Dependencies:** T5 · **Scope:** M

---

### Task 7: Claim validation ⚠️ trust-critical

**Description:** A validator that strips unsupported assertions from a take before persistence. Every
comparative/superlative claim must map to a `Claim` whose `quotedFrom` genuinely appears in the
source text. Unmatched assertions are removed; if that empties the take, the item publishes with
summary only.

**Acceptance criteria:**
- [ ] A take asserting "outperforms X" with no matching claim has that assertion stripped
- [ ] A take whose claims all verify passes through unmodified
- [ ] `quotedFrom` not present in source text → claim rejected
- [ ] Stripping is logged with a reason, visible in run logs
- [ ] **This task's tests are written before its implementation** (spec: trust constraint gets tests
      before it gets a UI)

**Verification:** `npm test -- claims` — must include a false-assertion case that is provably stripped

**Dependencies:** T6 · **Scope:** M

---

### Task 8: Topic classification

**Description:** Classify each item into the fixed 15-topic taxonomy with a confidence score, written
to `ItemTopic`. Multi-label — an item may carry several topics.

**Acceptance criteria:**
- [ ] Only slugs from the fixed taxonomy are accepted; unknown labels rejected
- [ ] Confidence stored per assignment
- [ ] Items matching no topic above threshold are stored unclassified rather than force-fit
- [ ] Tested against fixtures with expected topic assignments

**Verification:** `npm test -- topics`

**Dependencies:** T5 · **Scope:** S

---

### Task 9: Signal-based ranking ⚠️ product-critical

**Description:** Compute `importanceScore` from observable signals only — cross-source coverage, HN
points/comment velocity normalized against a trailing 30-day distribution, GitHub stars delta,
recency decay with a 14-day half-life. Persist the full `signalSnapshot` behind every score.
**No LLM involvement.**

**Acceptance criteria:**
- [ ] Score is a pure function of stored signals — same input, same output
- [ ] `signalSnapshot` records every input and its weight
- [ ] Fixture items produce an asserted, stable ordering
- [ ] An item covered by three sources outranks an equivalent item covered by one
- [ ] Recency is a multiplier, never a primary term — a two-week-old high-signal item can outrank
      today's low-signal item
- [ ] Cutoff is a tunable constant, not a hardcoded item count

**Verification:** `npm test -- ranking`

**Dependencies:** T4 · **Scope:** M

---

### ⚠️ Checkpoint B — GO/NO-GO ON THE PRODUCT THESIS
- [ ] `npm test` green, ranking and claim suites included
- [ ] Run ranking over the full fixture corpus and print the top 25 with signal breakdowns
- [ ] **Human reads that ordering and judges whether it is defensible**
- [ ] If the ordering feels arbitrary: phase-2 comparative reranking enters v1 scope. Do not proceed
      to UI and hope.

---

## Phase 3: Pipeline

### Task 10: Resumable pipeline runner

**Description:** Orchestrate fetch → dedupe → cluster → summarize → validate → classify → rank →
persist. Idempotent and resumable: per-item stage state, so a run interrupted mid-batch resumes
without duplicating work. Every run writes a structured log including *why* each dropped item was
dropped.

**Acceptance criteria:**
- [ ] Re-running over the same window creates no duplicate items
- [ ] A run killed mid-batch resumes and completes on the next invocation
- [ ] Run log records counts fetched/clustered/summarized/published/dropped
- [ ] Every drop carries a reason (dupe, validation failure, below cutoff)
- [ ] One failing item does not abort the batch

**Verification:** `npm test -- pipeline`; integration test kills a run mid-batch and resumes it.

**Dependencies:** T7, T8, T9 · **Scope:** L — *split if it exceeds 5 files*

---

### Task 11: Embeddings and related items

**Description:** Generate embeddings at ingest via Gemini's embedding endpoint; store in
`Item.embedding`. Add a pgvector similarity query powering "related items", excluding same-cluster
items (those are the same story, not related ones).

**Acceptance criteria:**
- [ ] Embedding generated for every published item
- [ ] Related-items query returns k nearest by cosine similarity
- [ ] Same-cluster items excluded from results
- [ ] Query returns in < 200ms on a few-thousand-item corpus

**Verification:** `npm test -- embeddings` + manual spot-check of related sets

**Dependencies:** T10 · **Scope:** M

---

### ✅ Checkpoint C
- [ ] Full ingest runs against live arXiv + HN
- [ ] Re-run produces zero duplicates
- [ ] Database holds a rankable feed with grounded takes
- [ ] Gemini rate limits measured — open question 1 answered

---

## Phase 4: User-facing

### Task 12: Auth and user bootstrap

**Description:** Auth.js with GitHub OAuth. New users get a `User` row and land in topic selection.

**Acceptance criteria:**
- [ ] Sign in / sign out works
- [ ] `User` created on first sign-in, not duplicated on subsequent ones
- [ ] Unauthenticated access to `/feed` redirects to sign-in
- [ ] Session available server-side in App Router

**Verification:** `npm test -- auth` + manual sign-in

**Dependencies:** T2 · **Scope:** M · *Parallelizable — independent of the pipeline*

---

### Task 13: Topic selection UI

**Description:** Post-signup screen to pick from the 15 topics, persisted to `UserTopic`. Editable
later from settings.

**Acceptance criteria:**
- [ ] All 15 topics shown with labels
- [ ] Selections persist and survive reload
- [ ] At least one topic required before reaching the feed
- [ ] Keyboard accessible; labels bound to inputs

**Verification:** `npm test -- topics-ui` + manual

**Dependencies:** T12 · **Scope:** S

---

### Task 14: Feed UI

**Description:** The feed — items ordered by `importanceScore` (never `publishedAt`), scoped to the
user's topics and cadence window (since last visit, 7-day fallback, 30-day ceiling). Each item shows
title, summary, take, source attribution, and visible citations on claims.

**Acceptance criteria:**
- [ ] Ordering is by `importanceScore`; verified in test, not by eye
- [ ] Every comparative assertion renders its citation as a link to the quoted source
- [ ] Empty/quiet windows render a short feed — **never padded to a quota**
- [ ] Responsive; readable on mobile
- [ ] `last_visited_at` updated on view

**Verification:** `npm test -- feed` + manual review

**Dependencies:** T11, T13 · **Scope:** L — *split UI shell from data layer if needed*

---

### Task 15: Item exits

**Description:** The three exits per item — full source (external link), related items (T11 query),
and dig deeper (on-demand ~500-word expansion, cached after first generation, bound by the same claim
rules).

**Acceptance criteria:**
- [ ] Source link opens the canonical URL
- [ ] Related items render 3–5 genuinely related items
- [ ] Dig deeper generates on first request, serves cached afterward
- [ ] Expansion runs through claim validation identically to the take
- [ ] Loading state while generating

**Verification:** `npm test -- exits` + manual on a real item

**Dependencies:** T14 · **Scope:** M

---

### Task 16: Dismiss and interaction tracking

**Description:** Record `seen` / `dismissed` / `opened` / `deepened` in `Interaction`. Dismissed
items never reappear for that user.

**Acceptance criteria:**
- [ ] Dismiss removes the item from that user's feed permanently
- [ ] Dismissal is per-user, not global
- [ ] Interactions recorded without blocking render
- [ ] Dismissed items excluded at query level, not hidden client-side

**Verification:** `npm test -- interactions`

**Dependencies:** T14 · **Scope:** S

---

### ✅ Checkpoint D
- [ ] E2E green: sign in → topics → feed → dismiss → reload → item absent
- [ ] Spec success criteria 1–9 verified
- [ ] Human uses the real feed for a session and reports whether it delivers

---

## Phase 5: Operations

### Task 17: Admin runs page

**Description:** `/admin/runs` rendering recent pipeline runs — counts, durations, dropped items with
reasons, and for any published item, the signal breakdown behind its rank. Debugging surface, not a
user feature.

**Acceptance criteria:**
- [ ] Recent runs listed with stage counts and duration
- [ ] Dropped items shown with their drop reason
- [ ] Any feed item can be traced to the numbers that ranked it (spec criterion 8)
- [ ] Not reachable by non-admin users

**Verification:** Manual against real run data

**Dependencies:** T10 · **Scope:** M · *Parallelizable*

---

### Task 18: Cron and production deploy

**Description:** Vercel Cron hitting `/api/cron/ingest` on a schedule, secured against public
invocation. Neon Postgres provisioned, migrations applied, env vars set in Vercel.

**Acceptance criteria:**
- [ ] Cron triggers ingestion on schedule
- [ ] Endpoint rejects unauthenticated requests
- [ ] Production migrations applied
- [ ] No secret present in the repository (spec criterion 11)
- [ ] A full batch completes within the execution limit, or chunking is tuned until it does

**Verification:** Observe two consecutive scheduled runs succeed in production

**Dependencies:** T14, T17 · **Scope:** M

---

### ✅ Checkpoint E
- [ ] All 11 spec success criteria met
- [ ] Scheduled ingestion running in production
- [ ] Open questions 1 and 2 answered with measurements

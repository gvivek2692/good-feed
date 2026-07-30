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

---

### Task 3b: HuggingFace Papers adapter *(added after ADR 001)*

**Description:** Adapter for `https://huggingface.co/api/daily_papers`, normalizing to
`NormalizedItem` like the other two. This source exists to supply the cross-source join that arXiv
and HN cannot form with each other — see
[ADR 001](../docs/adr/001-source-selection-and-cross-source-joins.md).

Each entry carries `paper.id` (the arXiv ID), `githubRepo`, `githubStars`, `upvotes`, and
`numComments` — the arXiv ID is the join key, the rest are ranking signals.

**Acceptance criteria:**
- [ ] Returns `Result<NormalizedItem[], SourceError>`; malformed entries dropped, not thrown
- [ ] `signals` carries `upvotes`, `githubStars`, `comments`, `repoUrl`, `arxivId`
- [ ] Paginates by date (`?date=YYYY-MM-DD`), since the API is day-scoped
- [ ] 14-day fixture committed (~245 entries measured)
- [ ] Test asserts the arXiv-ID join against the arXiv fixture finds pairs

**Verification:** `npm test -- huggingface`

**Dependencies:** T3 · **Scope:** M

**Note:** Papers with Code is dead — `/api/v1/papers/` 302s to HuggingFace. Do not add it.

---

### ✅ Checkpoint A
- [ ] Build, tests, lint, typecheck all green
- [ ] Migration applies to a fresh DB
- [ ] Fixtures captured and committed for all three sources
- [ ] Human review before Phase 2

---

## Phase 2: The risky core

> Built and tested **before any UI**. If ranking or grounding fails, it fails cheaply here.

### Task 4: Clustering and dedupe *(revised after ADR 001)*

**Description:** Group items covering the same underlying development into a `clusterId`.

**Clustering happens only within the research cluster** (arXiv ↔ HuggingFace Papers), joined on
**arXiv ID** — the measured join is 91 pairs / 37% of HF papers. HN items do not cluster with papers:
measured zero pairs against both the arXiv and HF corpora, via three independent strategies.

The original criterion "an arXiv paper and its HN submission land in one cluster" was **removed as
unachievable** — see [ADR 001](../docs/adr/001-source-selection-and-cross-source-joins.md).

**Acceptance criteria:**
- [x] An arXiv paper and its HuggingFace Papers entry land in one cluster, joined on arXiv ID
- [x] Version suffixes normalize — `2607.22534v1` and `2607.22534v2` are the same paper
- [x] Distinct papers by the same authors stay separate
- [x] HN items are never merged into a research cluster
- [x] Asserted against the ≥91 real pairs present in the committed fixtures
- [x] Precision favored over recall — a bad merge hides an item, a missed dupe only costs a slot

**Result:** 700 fixture items → 609 clusters, **exactly 91 multi-source**, all ARXIV+HUGGINGFACE.
Matches the ADR 001 measurement. No item is lost or double-counted.

**Verification:** `npm test -- clustering`

**Dependencies:** T3b · **Scope:** M

**Note:** The arXiv-ID join is exact, so embeddings are not required for clustering. Title-similarity
fallback is optional and should only be added if the exact join proves insufficient.

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
- [x] A take asserting "outperforms X" with no matching claim has that assertion stripped
- [x] A take whose claims all verify passes through unmodified
- [x] `quotedFrom` not present in source text → claim rejected
- [x] Stripping is logged with a reason, visible in run logs
- [x] **This task's tests are written before its implementation** (spec: trust constraint gets tests
      before it gets a UI)

**Verification:** `npm test -- claims` — must include a false-assertion case that is provably stripped

**Status:** Done — 27 tests. Live check on 5 real clusters: 1 genuine strip (fabricated
"single-task"/"contact points" comparison), 0 false positives after LaTeX normalization.

**Dependencies:** T6 · **Scope:** M

---

### Task 8: Topic classification

**Description:** Classify each item into the fixed 15-topic taxonomy with a confidence score, written
to `ItemTopic`. Multi-label — an item may carry several topics.

**Acceptance criteria:**
- [x] Only slugs from the fixed taxonomy are accepted; unknown labels rejected
- [x] Confidence stored per assignment
- [x] Items matching no topic above threshold are stored unclassified rather than force-fit
- [x] Tested against fixtures with expected topic assignments

**Verification:** `npm test -- topics`

**Status:** Done — 18 tests. Live check on 20 real clusters: 0 invented slugs, 0 unclassified,
37 assignments across 11/15 slugs. Confidence measured uncalibrated (7 distinct values, min 0.60);
threshold left at 0.55 rather than tuned to look effective.

**Dependencies:** T5 · **Scope:** S

---

### Task 9: Signal-based ranking ⚠️ product-critical *(revised after ADR 001)*

**Description:** Compute `importanceScore` from observable signals only. **No LLM involvement.**

Signals are **per-cluster**, since the two clusters share no items and their units are not
commensurable:

- **Research** (arXiv + HF): cross-source coverage, HF upvotes, GitHub stars, HF comments,
  category breadth
- **Discussion** (HN): points velocity, comment velocity, absolute points

**Cross-cluster comparability is decided** — [ADR 002](../docs/adr/002-cross-cluster-ranking.md):
percentile normalization against each source's own trailing 30-day distribution for *ordering*, plus
an absolute floor for *inclusion*.

**Acceptance criteria:**
- [x] Score is a pure function of stored signals — same input, same output
- [x] Percentiles are computed **per signal**, not per item — points and comment velocity have
      different distributions
- [x] `signalSnapshot` records raw values, each percentile, the distribution used (seeded vs.
      historical), the cluster, and within-cluster position
- [x] Fixture items produce an asserted, stable ordering
- [x] Within the research cluster, an item covered by two sources outranks an equivalent item
      covered by one
- [x] HN items are not systematically buried by their structural inability to carry a cross-source
      coverage signal — verified by asserting a high-signal HN item outranks a low-signal paper
- [x] **A weak week does not promote weak items** — assert that a corpus where nothing clears the
      absolute floor yields an empty feed, not a feed of 99th-percentile noise
- [x] Cold-start path works with the seeded fixture-derived distribution and is labelled as such
- [x] Recency is a multiplier, never a primary term
- [x] Cutoff is a tunable constant, not a hardcoded item count

**Verification:** `npm test -- ranking`

**Status:** Done — 27 tests. Full-corpus run found absolute recency decay dominating cross-cluster
ordering (18/25 top slots to HN); fixed by normalizing recency against each cluster's median age
(now 12 papers / 13 HN). See ADR 002 amendment.

**Dependencies:** T4 · **Scope:** M

---

### ⚠️ Checkpoint B — GO/NO-GO ON THE PRODUCT THESIS — **GO** (2026-07-27)
- [x] `npm test` green, ranking and claim suites included — 161 tests
- [x] Run ranking over the full fixture corpus and print the top 25 with signal breakdowns —
      `npx tsx scripts/check-ranking.mts`, 609 clusters
- [x] **Human reads that ordering and judges whether it is defensible** — judged defensible
- [x] **Judge cross-cluster interleaving specifically** — 12 papers / 13 HN in the top 25, HN at
      positions 1,2,3,4,6,7,9,10,12,13,15,16,25. The first run failed this (7/18, HN holding 1-14
      unbroken); cause was absolute recency decay encoding a 2.1x penalty on papers, fixed by
      normalizing recency per cluster. See the ADR 002 amendment.
- [x] Phase-2 comparative reranking **stays deferred** — the ordering did not read as arbitrary.

**Carried forward as the open risk:** HN items carry 4 signals while papers average 1.96 of 3, so
an HN score is a robust average where many paper scores rest on one noisy value. Revisit at
Checkpoint C against live data, where the fixture's collection bias no longer applies.

---

## Phase 3: Pipeline

### Task 10: Resumable pipeline runner *(split — L, per the task's own guidance)*

**Description:** Orchestrate fetch → dedupe → cluster → summarize → validate → classify → rank →
persist. Idempotent and resumable: per-item stage state, so a run interrupted mid-batch resumes
without duplicating work. Every run writes a structured log including *why* each dropped item was
dropped.

**Acceptance criteria:**
- [x] Re-running over the same window creates no duplicate items — *10a*
- [x] A run killed mid-batch resumes and completes on the next invocation — *10b*
- [x] Run log records counts fetched/clustered/summarized/published/dropped — *10b*
- [x] Every drop carries a reason (dupe, validation failure, below cutoff) — *10b*
- [x] One failing item does not abort the batch — *10b*

**Verification:** `npm test -- pipeline`; integration test kills a run mid-batch and resumes it.

**Dependencies:** T7, T8, T9 · **Scope:** L — *split if it exceeds 5 files*

#### Task 10a: Idempotent persistence ✅ done

Maps a scored cluster into Source/Item/Claim/ItemTopic in one transaction, keyed on the natural
`(kind, externalId)` unique constraint. Claims and topics are replaced wholesale on re-persist, so a
stale claim can never cite an assertion the current take no longer makes.

`src/lib/pipeline/persist.ts` · 10 tests against real Postgres · verified idempotent over 3
consecutive runs (counts flat at 2 sources / 1 item / 1 claim / 1 topic).

#### Task 10b: Run orchestration and resumability ✅ done

`src/lib/pipeline/runner.ts` + `deps.ts` · 13 tests against real Postgres.

Resume needs no schema change: persistence is idempotent on `(kind, externalId)`, so an interrupted
run leaves finished items in place and the next pass skips what is already published. Ranking runs
*before* summarization so quota is never spent on items that cannot clear the floor.

Two bugs found by running it, not by the tests:
- Stripped assertions were counted as dropped items, reporting `dropped: 3` on a run that published
  all 3. A dropped item is absent from the feed; a stripped assertion is a published item with a
  trimmed take. Now counted separately, both still logged.
- An **unclassified item was published and ranked #2** on the first live run. The feed filters by
  user-selected topics, so a topicless item is unreachable for every user while occupying a slot.
  Unclassified items are now dropped with a reason.

**Measured, answering spec open question 1:** 8 of 11 summarization calls failed with `rateLimit` on
the free tier. See AGENTS.md — real ingest needs a paid tier and/or pacing.

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

### ❌ Task 12: Auth and user bootstrap — BUILT, THEN REMOVED

**Status:** Implemented 2026-07-28 (GitHub OAuth, mark-as-read, save), removed 2026-07-30 by
explicit decision. See spec decision 2b.

The feed has no accounts. `User`, `Account`, `Session`, `VerificationToken`, `UserTopic` and
`Interaction` were dropped in migration `20260730131152_remove_auth_and_per_user_state`;
`next-auth` and `@auth/prisma-adapter` were uninstalled. Reachable in git history at `94c16cd`
if accounts are ever revisited.

---

### ❌ Task 13: Topic selection UI — OUT OF SCOPE (no accounts; decision 2b)

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

### ❌ Task 16: Dismiss and interaction tracking — OUT OF SCOPE (no accounts; decision 2b)

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
- [ ] E2E green: read feed → filter by topic → open a deep dive → source link resolves
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

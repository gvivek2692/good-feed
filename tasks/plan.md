# Implementation Plan: good-feed v1

**Implements:** [docs/spec/good-feed-v1.md](../docs/spec/good-feed-v1.md)
**Date:** 2026-07-27
**Starting state:** Empty directory. Not a git repo. Node v22.17.1, npm 10.9.2.

---

## Overview

Build a multi-user AI news feed that ingests from arXiv and Hacker News, clusters items covering the
same development, ranks them by signal-based importance, and renders short summaries with grounded
"why this matters" takes. Delivered in vertical slices — each phase leaves a working, demonstrable
system.

---

## Architecture Decisions

1. **Ranking has zero LLM involvement in v1.** Signal math only, fully unit-testable. This is the
   product's differentiator and it must be debuggable before it is clever.

2. **Claim grounding is enforced by schema validation, not prompting.** The LLM returns structured
   claims; a validator strips unsupported assertions before persistence. Tested before any UI exists.

3. **The pipeline is resumable from the start.** Every stage is idempotent and records per-item
   state. This is not premature optimization — Vercel execution limits and Gemini rate limits both
   make partial completion the normal case, not the exception.

4. **Ingestion is decoupled from ranking.** Sources write raw items; ranking recomputes from stored
   signals. Re-ranking never requires re-fetching.

5. **Build order is risk-first.** The two things that can kill this product — ranking that produces
   arbitrary orderings, and takes that assert false things — get built and tested in Phase 2, before
   any UI work. If they fail, they fail cheaply.

6. **A local seed corpus is captured early** (Task 3) so ranking and summarization can be developed
   and tested without hitting live APIs on every iteration.

---

## Dependency Graph

```
Scaffold (T1) ──→ Schema (T2)
                     │
      ┌──────────────┼─────────────────┐
      ▼              ▼                 ▼
  Sources (T3)   Auth (T8)        LLM client (T5)
      │              │                 │
      ▼              │                 ▼
  Dedupe/           │          Summarize+Claims (T6)
  Cluster (T4)      │                 │
      │              │                 ▼
      ▼              │          Claim validation (T7)
  Ranking (T9) ◄─────┘                 │
      │                                │
      └────────────┬───────────────────┘
                   ▼
            Pipeline runner (T10)
                   │
      ┌────────────┼────────────┐
      ▼            ▼            ▼
  Topics UI    Feed UI      Admin runs
    (T11)       (T12)         (T14)
                   │
                   ▼
          Item exits: source /
          related / deeper (T13)
                   │
                   ▼
             Cron + deploy (T15)
```

---

## Task List

### Phase 1: Foundation

- [x] **Task 1:** Scaffold Next.js + TypeScript + Tailwind, tooling, git init
- [x] **Task 2:** Prisma schema and first migration
- [x] **Task 3:** Source adapters (arXiv, HN) + recorded fixtures
- [ ] **Task 3b:** HuggingFace Papers adapter + 14-day fixtures *(added after ADR 001)*

**Checkpoint A:** Repo builds, tests run, migrations apply, fixtures captured.

### Phase 2: The risky core (built before any UI)

- [ ] **Task 4:** Cross-source clustering and dedupe
- [ ] **Task 5:** Gemini client wrapper with retry/backoff
- [ ] **Task 6:** Summary + take + claim extraction
- [ ] **Task 7:** Claim validation (strips unsupported assertions)
- [ ] **Task 8:** Topic classification into fixed taxonomy
- [ ] **Task 9:** Signal-based ranking

**Checkpoint B:** Ranking and claim validation are green under test with fixture data. **Human
review of actual ranked output before proceeding** — this is the go/no-go on the product thesis.

### Phase 3: Pipeline and persistence

- [ ] **Task 10:** Resumable pipeline runner with run logging
- [ ] **Task 11:** Embeddings + related-items query

**Checkpoint C:** A full ingest run completes against live APIs, is idempotent on re-run, and
populates a rankable feed in the database.

### Phase 4: User-facing

- [ ] **Task 12:** Auth (GitHub OAuth) + user bootstrap
- [ ] **Task 13:** Topic selection UI
- [ ] **Task 14:** Feed UI with items, takes, citations
- [ ] **Task 15:** Item exits — source, related, dig deeper
- [ ] **Task 16:** Dismiss and interaction tracking

**Checkpoint D:** Full E2E flow green: sign in → select topics → read feed → dismiss → persists.

### Phase 5: Operations

- [ ] **Task 17:** Admin runs page
- [ ] **Task 18:** Vercel cron + production deploy

**Checkpoint E:** All spec success criteria met. Scheduled ingestion running in production.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Cross-cluster ordering is arbitrary** | **High** — the two clusters have no commensurable units | Open problem named in the spec with three candidate approaches. Must be decided before T9 and judged at Checkpoint B. Discovered by measurement (ADR 001), not left to surface in production. |
| **Signal ranking produces arbitrary-feeling order** | **High** — kills the product thesis | Checkpoint B is an explicit human review of real ranked output before any UI investment. Failure here means phase-2 reranking moves into v1 scope, not that we ship and hope. |
| **HF is a curated funnel, not comprehensive** | Med | ~17 papers/day vs arXiv's ~143. HF absence is *not* evidence of unimportance; never treat it as a negative signal. |
| **Takes assert things the source doesn't claim** | **High** — kills credibility | Claim validation (T7) is built and tested before the UI can render a take. Enforced in code, not prompt. |
| Gemini rate limits throttle ingest | Med | Backoff + resumable batches from T5/T10. Affects cadence, not architecture. |
| Vercel execution limit on full batch | Med | Chunked resumable runs (T10). Worst case: ingestion moves to a separate worker. |
| Clustering over-merges distinct work | Med | Conservative thresholds; T4 unit-tested against hand-labeled fixtures. Over-merging is worse than under-merging — a missed dupe costs a slot, a bad merge hides an item. |
| Cold-start feed is empty | Low | T3 fixtures + first live run seed the DB before any user sees it. |
| Model IDs stale | Low | Verified against live Google docs during T5, pinned in one file. |

---

## Parallelization

Mostly sequential by dependency. Genuinely parallel opportunities:

- **T3 (sources)** and **T5 (LLM client)** — independent after T2.
- **T12 (auth)** — independent of the entire pipeline; can be built any time after T2.
- **T17 (admin page)** — needs T10's run logs but nothing else.

Everything in Phase 2 is a dependency chain and should stay sequential.

---

## Open Questions

Carried from the spec, both operational rather than blocking:

1. Gemini rate limits at this account tier — measured during T10's first live run.
2. Whether a full ingest batch fits Vercel's execution window — measured during T18.

One new question surfaced by planning:

3. **Does `bge`-quality clustering need embeddings, or is title/URL similarity enough?** T4 starts
   with cheap lexical matching. If precision is poor against fixtures, T4 gains a dependency on T11
   (embeddings) and both move earlier. Decided by measurement in T4, not now.

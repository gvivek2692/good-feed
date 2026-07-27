# good-feed — Confirmed Intent

**Status:** Confirmed 2026-07-27 via `interview-me`. Supersedes the curriculum framing decided
earlier the same day (see "Prior reversal" below).

---

## Intent

- **Outcome:** A web app that turns scattered AI research and engineering developments into short,
  opinionated summaries — each stating what the item is *and why it matters* — acting as a hub with
  paths to the source, related items, or a longer explanation.

- **User:** AI engineers, each setting topic interests so the feed matches their subfield.
  Vivek is user zero.

- **Why now:** Information is scattered across arXiv, X, HN, and blogs, and reading full papers
  costs more time than it's worth for most items.

- **Success:** A user opens the app, spends a few minutes, and leaves knowing what happened in their
  areas and which parts were significant — without opening a single paper. They come back.

- **Constraint:** Summaries must be trustworthy — *including the judgment calls*. An item claiming
  something "supersedes X" when it doesn't is worse than no summary at all.

---

## Scope

### In scope

- Ingestion from multiple scattered sources (arXiv, X, HN, blogs — exact set is a spec decision).
- Short summaries carrying the central ideas and concepts, not full-paper detail.
- A **"why this matters" take** per item: significance, what it builds on or supersedes, who should
  care.
- Ranking by **judged importance**, not recency alone.
- Per-user topic interests driving what reaches each feed.
- Three exits per item: full source · related items · dig deeper (longer generated explanation).

### Out of scope

- Telling users what to **do** with what they read. No suggested next steps, no "try this in your
  project," no codebase awareness.
- It has opinions about **the field**, not about your work.

This boundary was chosen deliberately. Three positions were offered:

| | Position | Chosen |
|---|---|---|
| A | Informational + navigational — never says "you should" | |
| B | **Contextual — carries a "why this matters" take** | ✅ |
| C | Actionable — suggests next steps for your project | |

C is what pulls this back toward the curriculum shape. Proposals that drift into C should be
rejected or re-confirmed explicitly.

---

## Consequences of choosing B

Two things follow from the contextual scope and should not be surprises later:

1. **The trust constraint got harder.** A neutral summary is wrong only if it misstates the paper.
   An opinionated one can also be wrong about *significance* — a harder error to catch and a more
   damaging one. Verification must cover the take, not just the facts. The spec needs a position on
   how takes are grounded: citation to the source's own claims, hedging, or human review at low
   volume.

2. **Ranking is the core of the product.** "Judged importance" means something has to decide what
   matters. That is the hardest part of the build and where most design effort belongs — not the UI.
   Ingestion, summarization, and feed rendering are all well-trodden. Deciding what matters is not,
   and it is the only reason to choose this over TLDR AI, AlphaSignal, Smol AI News, or Papers with
   Code — all free, all with existing distribution.

---

## Open assumption

**"Dig deeper" means a longer generated explanation of the same item** — not a tutorial, not a
course, not an implementation guide. Stated as an assumption rather than resolved in the interview.
Confirm before building that path.

---

## Prior reversal (2026-07-27)

`interview-me` ran twice on the same one-line ask on the same day and reached opposite conclusions.

- **Session 1** concluded aggregation was *not* the bottleneck and specced an opinionated curriculum
  (~80% sequenced learning, hard-capped ~5-item news gutter). Its diagnosis: Vivek already reads
  ~1hr/day, so the failure is **shapelessness** — no through-line, nothing accumulates — and more
  sources would make it worse. It framed "staying current" as anxiety and "being capable" as the
  real goal.
- **Session 2** (this document) concluded a personalized feed with contextual takes. Vivek described
  reading **cost** and **scatter**; the ~1hr/day figure never came up.

Vivek was shown the contradiction explicitly and chose the feed.

**Known weak point:** session 2 asked three times what reading a summary *accomplishes* and received
answers about interface affordances each time. The "Success" line above was inferred from that
pattern rather than stated directly. If the built feed goes unused or items pile up unread,
session 1's shapelessness diagnosis is the first hypothesis to revisit — before reaching for a new
ranking algorithm.

---

## Build preference

The agent **code loop** — agents extending this codebase — stays visible and inspectable. Learning
to build reliable loops is a co-equal goal, not a means to delivery. Never optimize that loop toward
opacity. (The content loop — ingestion, summarization, refresh — should be boring and unattended.)

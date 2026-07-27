# ADR 002: Cross-cluster ranking by percentile normalization

**Date:** 2026-07-27
**Status:** Accepted
**Depends on:** [ADR 001](001-source-selection-and-cross-source-joins.md)

## Context

ADR 001 established that the corpus forms two clusters sharing no items: research
(arXiv + HuggingFace Papers) and discussion (Hacker News). Their signals are not commensurable —
a paper with 200 HuggingFace upvotes and a story with 500 Hacker News points cannot be compared in
raw units, and no principled conversion exists.

The spec listed three candidate approaches and deferred the decision to this point.

## Decision

**Ordering is by percentile rank against each source's own trailing 30-day distribution.
Inclusion additionally requires clearing an absolute floor.**

Two separate mechanisms, deliberately:

| Mechanism | Purpose | Basis |
|---|---|---|
| **Percentile** | Where an item ranks | Relative to its own source's trailing 30 days |
| **Absolute floor** | Whether an item appears at all | Raw signal minimum |

### Why percentile for ordering

- **Signal-only.** No LLM in the ordering path, consistent with the spec's phase-1 constraint.
- **No hand-tuned cross-source weights.** The alternative — "1 HF upvote ≈ 2.5 HN points" — is an
  arbitrary constant that would need constant re-tuning and could never be defended.
- **Self-calibrating.** If HN gets quieter or HF upvote counts inflate, percentiles adjust with no
  code change.
- **Explainable.** "83rd percentile for Hacker News over the trailing 30 days" is a real answer to
  the spec's requirement that the feed can always say why an item is where it is.

### Why an absolute floor is also required

Percentiles discard magnitude. On a quiet week, the best available HN story sits at the 99th
percentile of a weak distribution and would outrank a genuinely significant paper at HF's 70th.
Percentile ranking alone guarantees each source's top items surface **whether or not anything
actually mattered** — directly contradicting the spec's rule that a quiet week produces a short feed
and that the feed is never padded.

The floor makes "nothing important happened" representable. An item must clear **both** its
percentile threshold and a raw minimum to reach the feed.

### Mechanics

- **Per-signal distributions, not per-item.** HN points and comment velocity have different shapes;
  each signal gets its own trailing distribution, and percentiles combine afterward.
- **Trailing window: 30 days**, matching the spec's existing normalization language.
- **Cold start.** No history exists at launch. v1 computes a seeded baseline distribution from the
  committed fixture corpus (14 days), replaced by real history as it accumulates. The baseline's
  provenance is recorded in `signalSnapshot` so early rankings are not mistaken for
  history-calibrated ones.
- **`signalSnapshot` must record**, for every item: raw signal values, the percentile each mapped
  to, which distribution was used (seeded vs. historical), the cluster the item ranked in, and its
  within-cluster position.

### Amendment (2026-07-27, Task 9): recency is normalized per cluster too

Implementing this ADR surfaced a case it did not anticipate. Percentile-normalizing the *signals*
while applying **absolute** exponential decay for recency reintroduced exactly the incomparability
the ADR exists to remove.

Measured over the full 609-cluster fixture corpus:

| | median age | median recency multiplier |
|---|---|---|
| Discussion (HN) | 0.9 days | 0.86 |
| Research (papers) | 3.6 days | 0.40 |

The 2.1× gap is an artifact of how the sources work — Algolia returns what is trending *now*, while
arXiv returns a 14-day window — not evidence that papers matter less. It put **18 of the top 25 in
one cluster**, with HN holding positions 1–14 unbroken. An HN story with the corpus maximum (1023
points, p100) ranked *below* three papers, which shows the ordering was driven by age rather than
signal.

Recency is therefore measured against **the cluster's own median age**, so it expresses "fresh for
its kind" rather than "recently published". The multiplier is clamped to [0.6, 1.4], keeping it a
multiplier rather than a primary term. Within-cluster ordering is unchanged by this.

After the change: **12 papers / 13 HN in the top 25**, with HN at positions 1, 2, 3, 4, 6, 7, 9, 10,
12, 13, 15, 16, 25.

**Still unresolved, for Checkpoint B:** HN items carry 4 signals each while papers average 1.96 of
3 (only 128/245 HuggingFace papers report GitHub stars, and arXiv-only items report neither upvotes
nor stars). An HN score is a robust four-signal average; many paper scores rest on a single noisy
one. This was left in place rather than fixed alongside recency, so the effect of each change stays
separable.

## Consequences

**Positive**

- Cross-cluster ordering becomes defensible without inventing a conversion rate.
- A quiet week produces a short feed rather than promoted noise.
- Ranking stays fully explainable in numbers.

**Negative**

- Requires maintaining trailing distributions per source per signal — more state than a stateless
  formula.
- The seeded cold-start baseline is derived from 14 days of fixtures, which may not represent
  typical activity. Early rankings are correspondingly less trustworthy.
- Percentile thresholds and absolute floors are two sets of tunable constants. They must be
  documented and justified, not quietly adjusted until the feed "looks right" — that would be
  hand-tuning the ordering, which is what percentile normalization exists to avoid.

**Revisit if**

At Checkpoint B, if the interleaved ordering still reads as arbitrary — one cluster dominating for
structural rather than merit reasons — this is evidence that phase-2 comparative reranking belongs
in v1. A model comparing two items directly does not need commensurable units, which is the exact
problem this ADR works around rather than solves.

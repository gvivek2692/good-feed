# ADR 001: Source selection and cross-source joins

**Date:** 2026-07-27
**Status:** Accepted
**Supersedes:** the two-source assumption in [docs/spec/good-feed-v1.md](../spec/good-feed-v1.md)

## Context

The spec named cross-source coverage — the same development appearing in more than one source — as
"the strongest signal available" for ranking. Task 4's acceptance criteria required that "an arXiv
paper and its HN submission land in one cluster."

After building the arXiv and Hacker News adapters (Task 3), the fixture corpus contained zero
cross-source pairs. The initial hypothesis was a fixture artifact: the arXiv capture covered a single
3.5-hour window while the HN capture covered 14 days, so non-overlap was close to arithmetically
guaranteed.

## Measurement

The arXiv capture was widened to the same 14-day window (2026-07-13 to 2026-07-27), yielding
**2,000 papers** against **64 HN stories** — a corpus 33× larger than the one that produced the
original zero.

Three independent join strategies were tested:

| Join strategy | Pairs found |
|---|---|
| HN URL → arXiv `abs`/`pdf` ID | 0 |
| Shared GitHub repo URL | 0 |
| Title token similarity (Jaccard ≥ 0.5) | 0 |

**The hypothesis was wrong.** Zero was not a fixture artifact.

The cause is visible in what HN actually posts. Of 64 stories: 16 linked to GitHub (tools and demos,
not paper implementations), the rest to industry news, blogs, and Show HN launches. Top stories
included "Bento — An entire PowerPoint in one HTML file", "PGSimCity — How PostgreSQL Works", and
"Hetzner is working on LLM Inference". None were research papers.

Separately, only **4.4%** of arXiv papers (88 of 2,000) declare a GitHub repo in `arxiv:comment`,
so the repo-URL join axis barely exists on raw arXiv either.

**arXiv and HN are topically adjacent but disjoint at the item level.** arXiv is research output;
HN is engineering artifacts and industry news.

### Candidate third sources

| Source | Result |
|---|---|
| Papers with Code | **Dead.** `/api/v1/papers/` returns 302 → `huggingface.co/papers/trending`. Absorbed by HuggingFace. |
| HuggingFace Papers | **Works.** `/api/daily_papers` returns arXiv ID, GitHub repo, stars, upvotes, comments. |

HuggingFace Papers over the same 14-day window: **245 papers**.

| Measurement | Result | Compare |
|---|---|---|
| Carrying a GitHub repo | **136 (56%)** | raw arXiv: 4.4% |
| Joining to the arXiv corpus by ID | **91 (37%)** | arXiv↔HN: 0% |
| Joining to HN via repo URL | **0** | — |
| Carrying upvotes | 245 (100%), range 1–298 | — |
| Star counts available | range 0–1262 | — |

## Decision

**1. Add HuggingFace Papers as a third source.**

It supplies the cross-source join that arXiv and HN cannot form with each other: 91 real pairs by
arXiv ID, plus community signals (upvotes, stars) that are ranking inputs in their own right.

**2. Model the corpus as two clusters, not one.**

- **Research cluster** — arXiv + HuggingFace Papers, joined on arXiv ID. Cross-source coverage
  works here and remains a strong signal.
- **Discussion cluster** — Hacker News, standalone. No cross-source coverage signal is available,
  measured twice against two different corpora.

**3. Rank per-source, not with one universal formula.**

Research items rank on cross-source coverage, HF upvotes, GitHub stars, and category signals.
HN items rank on points and comment velocity. Combining the two into one ordering is an open
problem — see Consequences.

## Consequences

**Positive**

- 91 genuine cross-source pairs exist to test clustering against, where previously there were none.
- HF's 56% repo coverage makes the paper↔code link viable, which raw arXiv's 4.4% did not.
- HF upvotes and stars are real, observable ranking signals requiring no LLM judgment — consistent
  with the spec's phase-1 signal-only ranking.

**Negative**

- A third adapter, fixture set, and test suite to build and maintain.
- **HN items can never carry a cross-source coverage signal.** Any ranking formula weighting that
  signal heavily will systematically rank HN below research items, regardless of merit.
- **HF is a curated funnel, not a comprehensive source.** 245 papers over 14 days (~17/day) against
  arXiv's 2,000. HF tells us which papers people *noticed*; it is a quality filter, not coverage.
  Treating HF absence as evidence of unimportance would be a mistake.

**Open problem — cross-cluster comparability**

How does a 200-upvote paper compare against a 500-point HN story on a single axis? The units are not
commensurable and no principled conversion exists. Options, none yet chosen:

- Normalize each source against its own trailing distribution (percentile rather than raw score).
- Interleave two separately-ranked lists at a fixed ratio.
- Keep the clusters visually separate in the feed and decline to compare them at all.

This must be decided before Task 9 and verified at Checkpoint B.

## Notes

- arXiv's `search_query` **does** support boolean `OR` and date ranges via
  `submittedDate:[YYYYMMDDHHMM TO YYYYMMDDHHMM]`. Algolia's `query` does **not** support `OR`
  (see [AGENTS.md](../../AGENTS.md)). The two APIs differ here; do not carry an assumption across.
- arXiv requests should be spaced ~3s apart when paginating.

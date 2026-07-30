# ADR 003: GitHub trending as a fourth source

**Date:** 2026-07-30 · **Status:** Accepted

## Context

The feed carried papers (arXiv, HuggingFace) and discussion (Hacker News), but not the code AI
engineers actually adopt. A repo gaining stars quickly is a development in the same sense a paper
is, and nothing in the pipeline surfaced it.

## Decision 1: scrape github.com/trending rather than derive trending from the API

**There is no trending API.** `api.github.com/trending` returns 404. `/search/repositories` sorts by
*total* stars, which returns AutoGPT (185k stars, created 2023) above everything — a famous-repos
list, not a trending one.

An earlier draft of the plan concluded trending had to be constructed from `/search/repositories`
with a `created:` date window plus a star-history table to compute deltas. That was wrong, and the
error was checking the API and stopping rather than checking the page.

`github.com/trending` is server-rendered HTML — 14 rows daily, 21 weekly — and each row states
**"N stars today"**. GitHub computes momentum for us. This is strictly better than deriving it:

- No star-history table, no warm-up period before the signal exists.
- It catches **established repos spiking**, which a `created:` window structurally cannot. The daily
  list included `microsoft/AI-For-Beginners` (2021) and `dotnet/aspnetcore` (2014) alongside
  week-old repos.

`/trending` is not disallowed by robots.txt. One request per run.

**Cost, accepted knowingly:** unversioned markup with no stability contract. Mitigated by treating
"fetched a page but parsed no rows" as a `SourceError`, never an empty success — a restyle fails
loudly instead of silently removing the source, which would be indistinguishable from a quiet day.
`/search/repositories` + `created:` remains the documented fallback.

## Decision 2: a third ranking cluster, `code`

Repos fit neither existing cluster. Stars are not upvotes and not HN points, and ADR 001 forbids
comparing incommensurable units across clusters. Folding repos into `discussion` would have
corrupted the ordering of items already in the feed.

Weights, measured on the daily page (n=14):

| Signal | Weight | Why |
|---|---|---|
| `starsToday` | 0.8 | The only signal describing *now*. min=5, p50=180, max=916, with **14 distinct values in 14 rows** — no ties, so percentile rank is fully informative. Contrast `hfComments`, excluded from the research cluster for the opposite reason. |
| `stars` | 0.2 | Corroboration only. Alone it ranks by fame (p50=26k, max=236k) and would surface every large repo — the exact failure this source exists to avoid. |
| `forks` | — | Excluded. p50=3253 against stars p50=26219; it tracks total stars closely enough to add correlation rather than signal. |

**Absolute floor: 50 `starsToday`**, between the observed min (5) and p25 (68). It cuts the tail that
is on the page for reasons other than momentum — `dotnet/aspnetcore` at +5, `WhiskeySockets/Baileys`
at +12 — without cutting into the body of the distribution. **This assumes the daily window**; the
weekly page is a different scale (min=996, p50=2892).

Per-cluster structures are now built from `CLUSTER_KINDS` rather than spelling the kinds out, so a
future cluster cannot be half-added. Typecheck caught four sites; a fifth — the floor check — was a
silent fallthrough that would have floored repos on `points`, a signal they never carry, rejecting
every repo.

## Decision 3: the topic classifier is the AI filter

**The trending page is all of GitHub, not AI — measured 3 of 14 rows AI-related.** Rather than a
keyword regex, every row is classified and anything placed in no topic is dropped, which the runner
already does with a recorded reason.

Measured on 6 real repos:

| Repo | Topics | Correct? |
|---|---|---|
| huggingface/speech-to-speech | speech-audio (0.95), agents (0.9) | yes |
| different-ai/openwork | agents (0.9), tooling-infra (0.8) | yes |
| microsoft/AI-For-Beginners | none | yes — a curriculum, not a development |
| awesome-systematic-trading | none | yes — finance |
| WhiskeySockets/Baileys | none | yes — WhatsApp library |
| pascalorg/editor | none | yes — 3D graphics |

2 kept, 4 dropped, all six judgments correct. No keyword list to maintain.

## Decision 4: a README cannot ground a claim about itself

The trust rule says every comparative assertion maps to verbatim source text. That rule assumed the
source is a paper abstract — a report of a measurement. **A README is promotional copy written by
the author and reviewed by nobody**, so quoting "the fastest inference engine" proves only that the
author wrote it.

`validateClaims` takes `sourceIsSelfPromotional`. When set, a quote containing unfalsifiable
self-praise is refused as grounding even though it matches character for character. Measured claims
from a README still pass — rejecting everything would make repo takes uniformly empty, which is its
own failure.

Measured: across 6 real repos, **0 assertions stripped**. The takes described what the code does
rather than repeating self-assessment.

## Measurements that contradicted the plan

Recorded because both nearly changed a decision:

**Duplicates were a non-issue.** I ranked "the same repo from GitHub and HN" the highest risk, on
ADR 001's finding that 16 of 64 HN stories linked to GitHub. Measured: **0 overlaps of 21 trending
repos**, with 8 HN stories linking repos — the sets were disjoint. HN surfaces repos when someone
submits and upvotes them; trending reflects star velocity. The join key is kept because it costs one
regex, but the risk is downgraded from High to Low.

**A bug in my own check script nearly reversed Decision 3.** It folded a failed classifier call and
a genuine no-topic result into the same empty array, reporting "5 of 6 unclassified" — a rate-limit
failure was indistinguishable from a rejection. I briefly concluded the classifier could not filter
repos. Re-measuring with the outcomes separated produced the table above. The script now reports
classifier errors separately.

## Consequences

- Four sources, three clusters. `SourceKind` gained `GITHUB`
  (`20260730135332_add_github_source_kind`).
- Repo READMEs are fetched at ingest via `src/lib/sources/article.ts`, reusing the fetcher built for
  HN link posts. A repo whose README cannot be fetched keeps its one-line description.
- The feed's unit of content is now broader than "a development described in prose". A repo is a
  thing that exists and is being adopted, which is a different kind of claim from a paper's result.

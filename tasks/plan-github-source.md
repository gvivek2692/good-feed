# Implementation Plan: GitHub trending repos as a fourth source

**Status:** Plan only. Adding a content source is an "ask first" item (AGENTS.md), and two
decisions below need your answer before Task G1 starts.

## Overview

Surface AI repos that are gaining stars quickly, as feed items alongside papers and HN stories.

**`github.com/trending` is the source.** It is server-rendered HTML — 14 repo rows in the daily
page, 21 in `?since=weekly` — and each row carries the momentum figure directly: **"N stars today"**.
GitHub computes trending for us, so no star-history table and no warm-up period are needed.

An earlier draft of this plan concluded trending had to be derived from `/search/repositories` +
star deltas. That was wrong: it tested `api.github.com/trending` (which is genuinely 404) and
stopped there, instead of checking the page. The page is better than anything derived — it catches
established repos spiking, which a `created:` window cannot: today's list includes
`microsoft/AI-For-Beginners` (created 2021) and `dotnet/aspnetcore` (2014) alongside week-old repos.

## Measured facts this plan rests on

Established by live calls on 2026-07-30, not assumed:

| Fact | Value | Consequence |
|---|---|---|
| `github.com/trending` | **200**, 14 rows server-rendered | Usable without JS. This is the source. |
| `api.github.com/trending` | **404** | No JSON API. HTML parsing is the only route — see the fragility risk. |
| Per-row data | repo, `repository_id`, **stars today**, language, description | `stars today` is the momentum signal, precomputed. |
| `?since=weekly` | 21 rows | A weekly window exists and returns more items. |
| Catches established repos | AI-For-Beginners (2021), aspnetcore (2014) | Beats a `created:` window, which sees only new repos. |
| **AI-related share of the daily list** | **3 of 14** | **The list is all of GitHub, not AI.** Filtering is required — see Decision A. |
| `/search/repositories` unauthenticated | 10 req/hour | Only relevant if the API is used to enrich rows. |
| Current feed items pointing at GitHub | 1 of 16 | Little overlap in the existing feed. |
| **Trending ∩ HN, measured 2026-07-30** | **0 of 21 repos** (8 HN stories linked repos; disjoint sets) | **Duplicates are not the risk I assumed.** HN surfaces repos when someone submits and upvotes them; trending reflects star velocity. Different mechanisms select different repos. G3 is therefore a cheap guard, not a core task. |

## The two decisions that need you

### Decision A: how to filter the trending list down to AI

**This replaces the earlier "how do we compute trending" question, which the page answers for us.**

The new problem the measurement exposed: **only 3 of 14 repos on today's daily list are AI-related.**
The rest are `dotnet/aspnetcore`, `jenkinsci/jenkins`, `ansible/ansible`, PowerToys. Ingesting the
page as-is would put Jenkins in an AI feed.

| Option | How | Trade-off |
|---|---|---|
| **A1. Keyword filter on name + description** | Regex over `ai\|llm\|agent\|model\|inference\|…` | Cheap and offline, but brittle both ways: misses an AI repo whose description avoids the words, admits "AI-powered" boilerplate. |
| **A2. Let the existing topic classifier decide** | Ingest all rows, drop anything the classifier places in no topic | Reuses machinery that already works and already drops unclassified items. Costs one LLM call per row (~14–21/day, negligible on the paid tier). |
| **A3. Language + keyword prefilter, then classifier** | Cheap filter first, classifier on survivors | Fewer LLM calls, but the prefilter can discard a real AI repo before the classifier ever sees it. |

**Recommendation: A2.** The topic classifier is the component whose actual job is "does this belong
in one of our 15 AI topics", it is already trusted for that on papers and HN, and the runner already
drops unclassified items with a recorded reason. A keyword regex would be a second, worse classifier
maintained in parallel. At 14–21 rows/day the cost is noise.

*Risk to watch:* the classifier has only ever seen abstracts and HN titles. A repo description is
much shorter. G5 verifies the unclassified rate on real rows before this is trusted — if it drops
genuinely-AI repos, fall back to A3.

### Decision B: which cluster a repo belongs to

Ranking is built on **exactly two clusters** (ADR 001) that share no items, each normalized against
its own signal distribution. A repo fits neither cleanly:

- Its signals are stars and forks, not upvotes or HN points.
- It is not a paper, so it never joins the research cluster on `arxivId`.
- It is not a discussion.

| Option | Effect |
|---|---|
| **B1. Third cluster, `code`** | Correct model. Requires extending `ClusterKind`, `SIGNAL_WEIGHTS`, `ABSOLUTE_FLOORS`, and `buildDistributions` — the ranking code assumes two clusters in several places. |
| **B2. Fold into `discussion`** | Cheap, and wrong: percentile-normalizing stars against HN points compares incomparable units, exactly what ADR 001 forbids. |

**Recommendation: B1.** B2 would corrupt the ranking of the existing discussion cluster, and the
percentile machinery is already per-cluster, so a third one is additive rather than a rewrite.

---

## Measured during implementation (2026-07-30)

Two results contradicted the plan and are recorded here rather than quietly fixed:

**1. Trending ∩ HN = 0 of 21.** I ranked duplicates the top risk. The sets were disjoint: HN
surfaces repos when someone submits and upvotes them, trending reflects star velocity. The join key
is kept (one regex) but the risk is downgraded.

**2. The classifier assigned NO topic to 5 of 6 real trending repos** — they would all be dropped as
unreachable. Decision A assumed the classifier could act as the AI filter. Two of the five drops are
correct (`awesome-systematic-trading` is finance, `pascalorg/editor` is 3D graphics), but
`huggingface/speech-to-speech` should reach `speech-audio` and did not.

The summaries and takes were good — the failure is classification alone, and **0 assertions were
stripped**, meaning no laundered marketing reached the takes. Diagnosis in progress: the classifier
receives `owner/repo` as TITLE, which is a slug rather than a description, unlike the paper titles
and HN headlines it was tuned on.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| ~~**Duplicate items**~~ — measured at **0 of 21** on 2026-07-30 | **Downgraded from High to Low.** I ranked this the top risk; the measurement disagreed. | G3 still implements the guard, since the cost is one join key and the overlap could rise. But it is no longer a blocking concern. |
| **Star count is gameable** | Medium. Star-farmed repos are real. | Absolute floor on stars *and* a floor on repo age; require a non-empty description and a real README. Ranking never uses an LLM score. |
| **HTML parsing is unversioned** — GitHub can restyle the page without notice | High. A markup change silently returns zero repos, and a source returning nothing looks identical to a quiet day. | G1 treats "page parsed but yielded 0 rows" as a `SourceError`, never an empty success. A structural change fails loudly on the next run. |
| **Not an official API** | Medium. No stability contract, and scraping etiquette applies. | One request per run, honest User-Agent, respect `robots.txt`. If it ever breaks or is disallowed, `/search/repositories` + a `created:` window remains as a documented fallback. |
| **Off-topic repos** — 11 of 14 trending rows are not AI | High. Jenkins in an AI feed is an obvious failure. | Decision A: the topic classifier drops them, with the unclassified rate measured in G5. |
| **Topic classifier has no "repo" concept** | Medium — a repo landing in no topic is dropped and invisible (this already bit us once) | Task G5 verifies classification on real repos before enabling the source in the runner. |
| **A repo is not a "development"** | Medium — the spec's unit is a development with a claim-grounded take | Task G4 decides what a repo's `whyItMatters` can honestly claim. README text is marketing, not an abstract. This is the trust risk, and it is why G4 is its own task. |

---

## Tasks

### ✅ Task G1: GitHub trending source adapter

**Description:** `src/lib/sources/github.ts` producing `NormalizedItem[]` from `github.com/trending`,
matching the existing adapter contract. Parses the server-rendered rows; no API token required for
the page itself.

Each row yields: `owner/name`, `repository_id` (stable numeric id, better than the name as
`externalId`), **stars today**, total stars, language, and description.

**Acceptance criteria:**
- [ ] Returns `NormalizedItem` with `kind: "GITHUB"`, `signals: { starsToday, stars, forks }`
- [ ] `externalId` is `repository_id`, so a rename does not create a duplicate item
- [ ] `arxivId: null` always — repos never join the research cluster
- [ ] **A parse yielding 0 rows returns `SourceError`, not an empty success** — a markup change must
      fail loudly rather than look like a quiet day
- [ ] Both `?since=daily` and `?since=weekly` supported
- [ ] Fixture captured from the live page in `tests/fixtures/`; unit tests run fully offline

**Verification:** `npm test -- github` + one live call in `scripts/check-sources.mts`
**Dependencies:** none · **Scope:** M

---

### ✅ Task G2: Schema and taxonomy for a code source

**Description:** Add `GITHUB` to the `SourceKind` enum and `ClusterKind`. **Schema change —
requires your approval per AGENTS.md.**

**Acceptance criteria:**
- [ ] `SourceKind` gains `GITHUB`; migration applied
- [ ] `ClusterKind` gains `code`; existing two clusters unaffected
- [ ] Existing 224 tests still pass unchanged

**Verification:** `npm test` + `npx prisma migrate dev` · **Dependencies:** Decision B · **Scope:** S

---

### ✅ Task G3: Cross-source repo dedupe

**Description:** A repo surfaced by both GitHub and HN must produce one item. Normalize
`github.com/{owner}/{name}` from HN `canonicalUrl` and match against the repo's full name.

**Acceptance criteria:**
- [ ] An HN story linking a repo and the repo itself collapse to one cluster
- [ ] The HN discussion signal is preserved on the merged item, not discarded
- [ ] URL matching handles `/blob/`, `/tree/`, trailing slashes, and case differences
- [ ] **Measured on real data**, with the overlap count recorded in the ADR

**Verification:** `npm test -- dedupe` + a live count · **Dependencies:** G1 · **Scope:** M

---

### 🔄 Task G4: What a repo item honestly claims

**Description:** The trust-critical task. Decide and implement what `summary` and `whyItMatters`
may assert for a repo, and what grounds them. A README is promotional text written by the author —
unlike an abstract, its claims are not peer-reviewed.

**Acceptance criteria:**
- [ ] Claim grounding runs against README text with the same verbatim-quote rule as papers
- [ ] The take never repeats a README's self-assessment as fact ("the fastest inference engine")
- [ ] Star count is reported as an observation, never as evidence of quality
- [ ] Reviewed against 10 real repos before the source is enabled

**Verification:** `npm test -- claims` + manual review of 10 items · **Dependencies:** G1 · **Scope:** M

---

### ✅ Task G5: Ranking and classification for the code cluster

**Description:** Signal weights, absolute floor, and a check that the topic classifier places repos
correctly. Floors matter more here than elsewhere: star-farmed repos are a real failure mode.

**Acceptance criteria:**
- [ ] `SIGNAL_WEIGHTS.code` and `ABSOLUTE_FLOORS.code` defined from the measured distribution of
      `starsToday` across real trending pages, not guessed
- [ ] Repos below the `starsToday` floor are dropped with a recorded reason
- [ ] **Classification verified on 20+ real trending rows; unclassified rate recorded.** If the
      classifier drops genuinely-AI repos on short descriptions, fall back to Decision A3
- [ ] Confirm off-topic repos (Jenkins, aspnetcore) are actually filtered out, not just assumed to be
- [ ] A full ranked run is **read by you and judged defensible**, as in Checkpoint B

**Verification:** `npx tsx scripts/check-ranking.mts` · **Dependencies:** G1, G2 · **Scope:** M

---

### Task G6: Wire into the runner and record the ADR

**Description:** Add the source to `fetchSources`, and write `docs/adr/003-github-source.md`
recording the trending-derivation decision, the measured overlap, and the rate-limit constraint.

**Acceptance criteria:**
- [ ] Full pipeline run publishes repo items end to end
- [ ] Re-running produces no duplicates
- [ ] A GitHub API failure degrades to the other three sources, never fails the run
- [ ] ADR 003 records what was measured, including anything that contradicted this plan

**Verification:** two consecutive live runs · **Dependencies:** G1–G5 · **Scope:** S

---

## Checkpoints

**After G1–G2:** Adapter returns real repos against fixtures; schema migrated; 224 existing tests
still green.

**After G3–G4:** Duplicate rate measured and near zero. **You read 10 generated repo takes and judge
whether they are trustworthy** — the same gate the summaries passed at Checkpoint B. If a take
launders README marketing into a claim, G4 is not done.

**After G5–G6:** Full run publishes repos, ordering judged defensible, ADR written.

## Out of scope

- Repo *releases* as separate items (a new version of an existing repo is a different unit)
- Contributor or commit-velocity signals — stars first, and only add signals that measurably change
  ordering
- Anything advising what to *do* with a repo ("try this") — spec boundary, unchanged

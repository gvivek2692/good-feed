# Deployment

The app is server-rendered against Postgres on every request, so it needs a host that runs Node and
a database it can reach.

## Why not GitHub Pages

Pages serves static files only. Measured, not assumed:

- `next build` marks both routes `ƒ (Dynamic) server-rendered on demand`.
- Forcing `output: "export"` fails: `Page "/item/[id]" is missing "generateStaticParams()"`.
- Both pages call Prisma at request time — the feed queries items, the item page reads (and on a
  miss, writes) a deep dive.

The `generateStaticParams` error is fixable; the database dependency is not. A static build also
breaks the on-demand deep-dive fallback, which *writes* — an item whose pre-generation failed would
be permanently broken rather than recovering on first visit.

## Hosting: Vercel + hosted Postgres

Vercel runs Next.js as-is; no code changes. The database needs the **pgvector** extension —
the init migration creates it, and embeddings are `vector(1536)`. Neon and Supabase both provide it
on a free tier.

1. Create the database, copy its connection string.
2. Import the repo into Vercel.
3. Set `DATABASE_URL` and `GEMINI_API_KEY` in Vercel's environment variables.
4. Apply the schema once: `DATABASE_URL=... npx prisma migrate deploy`
5. Seed topics (idempotent): `DATABASE_URL=... npx tsx prisma/seed.ts`

The feed is empty until an ingest runs — the app renders it, it does not generate it.

## Scheduled refresh

`.github/workflows/ingest.yml` runs the pipeline roughly every three days and can be triggered by
hand from the Actions tab (`workflow_dispatch`).

Required repository secrets — **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `DATABASE_URL` | The same hosted connection string Vercel uses |
| `GEMINI_API_KEY` | Google AI Studio key |

The workflow applies migrations, regenerates the Prisma client (Prisma 7 does not do this during
`migrate deploy`), seeds topics, runs the pipeline, then backfills any deep dive that failed to
pre-generate.

### Cadence

Every three days, not daily. The ranking floor rejects most candidates — the run of 2026-07-30
published 5 of 130 clusters — so running more often mostly spends quota re-examining items that were
already rejected. A quiet stretch is supposed to produce a short feed.

The schedule skips the 28th on purpose: including it would put a run one day after the previous one
every February. The worst case is now a 7-day gap rather than a wasted double-run.

### What to expect

A full pass took **~18 minutes** locally at 6s pacing, plus deep-dive pre-generation. The job
allows 60 minutes.

**The free Gemini tier is the real constraint, not CI.** Measured on 2026-07-27: 8 of 11
summarization calls failed with `rateLimit` in a single run. Retry-with-backoff and the 6s pacing
help but do not fix a quota that low. A scheduled run on the free tier will publish fewer items than
the sources justify — this is spec open question 1, still open. A paid tier is the fix.

Failures are non-fatal by design: a summarization failure drops that item, and a deep-dive failure
still publishes the item and falls back to on-demand generation. A run that hits its quota produces
a shorter feed rather than a broken one.

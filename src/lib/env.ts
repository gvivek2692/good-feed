import { config } from "dotenv";

/**
 * Loads local environment variables.
 *
 * `.env.local` is the Next.js convention for machine-local secrets, and the
 * framework loads it automatically — but scripts, Prisma, and Vitest run
 * outside Next and would otherwise see nothing. `dotenv/config` alone reads
 * only `.env`.
 *
 * This is imported for its side effect, so it must run before anything reads
 * `process.env`. The failure mode it prevents is quiet: without `DATABASE_URL`
 * the integration tests skip themselves and the suite still reports green.
 */
config({ path: ".env.local", quiet: true });
// Kept as a fallback so an existing .env still works.
config({ quiet: true });

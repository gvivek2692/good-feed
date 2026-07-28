import type { DefaultSession } from "next-auth";

/**
 * Adds the user id to the session type.
 *
 * Auth.js ships `name`/`email`/`image` only; the id is attached by the session
 * callback in `src/lib/auth/config.ts` and every per-user query needs it.
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

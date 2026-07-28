import { cache } from "react";

import { auth } from "@/lib/auth/config";

export interface SessionUser {
  id: string;
  name: string | null;
  image: string | null;
}

/**
 * The signed-in user, or null.
 *
 * This is the data access layer the Next.js authentication guide prescribes:
 * authorization is checked next to the data, not in `proxy.ts`. Proxy runs on
 * every request including prefetches, so a database check there is both slow
 * and — because a cookie can be present without a valid session — not
 * trustworthy on its own.
 *
 * Memoized with React's `cache` so several Server Components on one page share
 * a single session lookup per render pass.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth();
  const user = session?.user;
  if (!user?.id) return null;

  return { id: user.id, name: user.name ?? null, image: user.image ?? null };
});

/** The signed-in user's id, or null. The common case for per-user queries. */
export async function getSessionUserId(): Promise<string | null> {
  return (await getSessionUser())?.id ?? null;
}

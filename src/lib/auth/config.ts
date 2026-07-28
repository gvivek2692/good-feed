import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth, { type NextAuthResult } from "next-auth";
import GitHub from "next-auth/providers/github";

import { prisma } from "@/lib/db/client";

/**
 * Auth.js configuration.
 *
 * GitHub OAuth only — the audience is AI engineers, who have GitHub accounts,
 * and every additional provider is another failure mode for something the spec
 * calls "not the interesting part".
 *
 * Sessions are database-backed rather than JWT. The feed needs a real `User`
 * row to hang `UserTopic` and `Interaction` off, so the row has to exist
 * regardless; a JWT would add a second source of truth about who the user is
 * without removing the need for the first.
 */
const result: NextAuthResult = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [GitHub],
  session: { strategy: "database" },
  pages: { signIn: "/signin" },
  callbacks: {
    /**
     * Puts the user id on the session. Without this the session carries only
     * name/email/image, and every query that needs a `userId` would have to
     * look the user up again by email.
     */
    session({ session, user }) {
      if (session.user) session.user.id = user.id;
      return session;
    },
  },
});

export const handlers = result.handlers;
export const auth = result.auth;
export const signIn = result.signIn;
export const signOut = result.signOut;

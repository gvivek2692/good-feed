import Link from "next/link";
import { redirect } from "next/navigation";

import { signIn } from "@/lib/auth/config";
import { getSessionUser } from "@/lib/auth/session";

/**
 * Sign-in.
 *
 * The feed itself stays readable signed-out — the content is not the private
 * part, per-user state is. So this page explains what signing in buys rather
 * than acting as a wall.
 */
export default async function SignInPage(): Promise<React.ReactElement> {
  const user = await getSessionUser();
  if (user) redirect("/");

  return (
    <div className="min-h-full bg-white dark:bg-zinc-950">
      <div className="mx-auto max-w-md px-6 py-24">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
          Sign in to good-feed
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          The feed is readable without an account. Signing in lets you mark items read and save them
          for later, on any device.
        </p>

        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/" });
          }}
          className="mt-8"
        >
          <button
            type="submit"
            className="w-full rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Continue with GitHub
          </button>
        </form>

        <p className="mt-6 text-xs text-zinc-500 dark:text-zinc-500">
          <Link href="/" className="hover:underline">
            ← Back to the feed
          </Link>
        </p>
      </div>
    </div>
  );
}

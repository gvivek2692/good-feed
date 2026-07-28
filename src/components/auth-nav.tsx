import Link from "next/link";

import { signOut } from "@/lib/auth/config";
import { getSessionUser } from "@/lib/auth/session";

/** Sign-in / sign-out control and the link to saved items. */
export async function AuthNav(): Promise<React.ReactElement> {
  const user = await getSessionUser();

  if (!user) {
    return (
      <Link
        href="/signin"
        className="text-xs font-medium text-zinc-600 hover:underline dark:text-zinc-400"
      >
        Sign in
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3 text-xs">
      <Link href="/saved" className="font-medium text-zinc-600 hover:underline dark:text-zinc-400">
        Saved
      </Link>
      <span className="text-zinc-400 dark:text-zinc-600">{user.name ?? "Signed in"}</span>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
      >
        <button type="submit" className="text-zinc-500 hover:underline dark:text-zinc-500">
          Sign out
        </button>
      </form>
    </div>
  );
}

"use client";

import { signIn } from "next-auth/react";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

interface SignInPromptProps {
  /** Which control was clicked, so the copy names it rather than being generic. */
  feature: "read" | "saved";
  onDismiss: () => void;
}

const COPY = {
  read: {
    title: "Sign in to mark items read",
    body: "Marking an item read dims it in the feed so you can see what you have already worked through. That state is tied to your account, so it needs one.",
  },
  saved: {
    title: "Sign in to save items",
    body: "Saved items are kept on a page of their own, ordered by when you saved them. That list is tied to your account, so it needs one.",
  },
} as const;

/**
 * Explains why an account is needed, at the moment the reader asks for the
 * feature.
 *
 * A native `<dialog>` rather than a hand-rolled overlay: focus trapping, Escape
 * to close, inertness of the page behind, and the top layer are all platform
 * behaviour here, and reimplementing them in an app this size would be worse in
 * every case.
 */
export function SignInPrompt({ feature, onDismiss }: SignInPromptProps): React.ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  const copy = COPY[feature];
  // Return the reader to the page they were reading, not to the feed root.
  const callbackUrl = usePathname();

  useEffect(() => {
    // showModal, not the `open` attribute — only the former gets the top layer,
    // the backdrop, and focus containment.
    ref.current?.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      onClose={onDismiss}
      onClick={(event) => {
        // Clicking the backdrop closes. The dialog element itself is the event
        // target only when the click landed outside its content box.
        if (event.target === ref.current) ref.current?.close();
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg bg-white p-0 text-left backdrop:bg-zinc-900/40 dark:bg-zinc-900 dark:backdrop:bg-black/60"
    >
      <div className="p-6">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{copy.title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{copy.body}</p>
        <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          The feed itself stays readable without one.
        </p>

        <div className="mt-6 flex items-center gap-3">
          {/*
            Goes straight to GitHub rather than to /signin — the reader has
            already chosen to sign in by clicking here, so an interstitial page
            asking them to choose again is a wasted step. `signIn` is called
            from a form action so the CSRF token is handled for us.
          */}
          <form action={() => void signIn("github", { callbackUrl })}>
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              Continue with GitHub
            </button>
          </form>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
          >
            Not now
          </button>
        </div>
      </div>
    </dialog>
  );
}

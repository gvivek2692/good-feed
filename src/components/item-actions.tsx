"use client";

import { useOptimistic, useState, useTransition } from "react";

import { toggleRead, toggleSaved } from "@/app/actions/interactions";
import { SignInPrompt } from "@/components/sign-in-prompt";

interface ItemActionsProps {
  itemId: string;
  isRead: boolean;
  isSaved: boolean;
  signedIn: boolean;
}

const BASE = "rounded-full px-2.5 py-1 text-xs font-medium transition-colors";

/**
 * Mark-as-read and save controls.
 *
 * Optimistic when signed in: the button flips immediately and the server action
 * reconciles. These are low-stakes, reversible toggles, so waiting on a round
 * trip would make the feed feel broken for no gain in correctness.
 *
 * Signed out, the buttons stay live and explain themselves on click rather than
 * sitting disabled. A dead control tells a reader nothing about what it would
 * have done or how to get it — the click is the moment they have shown they
 * want the feature, which is the moment to say an account is needed.
 */
export function ItemActions({
  itemId,
  isRead,
  isSaved,
  signedIn,
}: ItemActionsProps): React.ReactElement {
  const [, startTransition] = useTransition();
  const [prompt, setPrompt] = useState<"read" | "saved" | null>(null);
  const [optimistic, setOptimistic] = useOptimistic(
    { read: isRead, saved: isSaved },
    (state, update: Partial<{ read: boolean; saved: boolean }>) => ({ ...state, ...update }),
  );

  function onToggle(kind: "read" | "saved"): void {
    if (!signedIn) {
      setPrompt(kind);
      return;
    }

    const next = !optimistic[kind];
    startTransition(async () => {
      setOptimistic({ [kind]: next });
      if (kind === "read") await toggleRead(itemId, next);
      else await toggleSaved(itemId, next);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => onToggle("read")}
        aria-pressed={signedIn ? optimistic.read : undefined}
        className={`${BASE} ${
          optimistic.read && signedIn
            ? "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"
            : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        }`}
      >
        {optimistic.read && signedIn ? "✓ Read" : "Mark read"}
      </button>

      <button
        type="button"
        onClick={() => onToggle("saved")}
        aria-pressed={signedIn ? optimistic.saved : undefined}
        className={`${BASE} ${
          optimistic.saved && signedIn
            ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
            : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        }`}
      >
        {optimistic.saved && signedIn ? "★ Saved" : "☆ Save"}
      </button>

      {prompt ? <SignInPrompt feature={prompt} onDismiss={() => setPrompt(null)} /> : null}
    </>
  );
}

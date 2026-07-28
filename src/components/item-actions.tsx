"use client";

import { useOptimistic, useTransition } from "react";

import { toggleRead, toggleSaved } from "@/app/actions/interactions";

interface ItemActionsProps {
  itemId: string;
  isRead: boolean;
  isSaved: boolean;
  /** Signed-out users see the controls disabled rather than not at all. */
  signedIn: boolean;
}

const BASE =
  "rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Mark-as-read and save controls.
 *
 * Optimistic: the button flips immediately and the server action reconciles.
 * These are low-stakes, reversible toggles, so waiting on a round trip would
 * make the feed feel broken for no gain in correctness.
 *
 * Shown disabled rather than hidden when signed out — a control that vanishes
 * teaches the reader nothing about why.
 */
export function ItemActions({
  itemId,
  isRead,
  isSaved,
  signedIn,
}: ItemActionsProps): React.ReactElement {
  const [, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(
    { read: isRead, saved: isSaved },
    (state, update: Partial<{ read: boolean; saved: boolean }>) => ({ ...state, ...update }),
  );

  function onToggle(kind: "read" | "saved"): void {
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
        disabled={!signedIn}
        aria-pressed={optimistic.read}
        title={signedIn ? undefined : "Sign in to mark items read"}
        className={`${BASE} ${
          optimistic.read
            ? "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"
            : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        }`}
      >
        {optimistic.read ? "✓ Read" : "Mark read"}
      </button>

      <button
        type="button"
        onClick={() => onToggle("saved")}
        disabled={!signedIn}
        aria-pressed={optimistic.saved}
        title={signedIn ? undefined : "Sign in to save items"}
        className={`${BASE} ${
          optimistic.saved
            ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
            : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        }`}
      >
        {optimistic.saved ? "★ Saved" : "☆ Save"}
      </button>
    </>
  );
}

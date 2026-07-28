"use server";

import { revalidatePath } from "next/cache";

import { getSessionUserId } from "@/lib/auth/session";
import { setInteraction, type ToggleableKind } from "@/lib/db/interactions";

export interface ToggleResult {
  ok: boolean;
  active: boolean;
  error?: "unauthenticated";
}

/**
 * Toggles read or saved for one item.
 *
 * The user id comes from the session, never from the caller — a server action
 * is a public HTTP endpoint, so accepting a `userId` argument would let anyone
 * write rows on anyone's behalf.
 */
async function toggle(
  itemId: string,
  kind: ToggleableKind,
  active: boolean,
): Promise<ToggleResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, active: !active, error: "unauthenticated" };

  const result = await setInteraction(userId, itemId, kind, active);

  // The feed and the saved list both render this state server-side.
  revalidatePath("/");
  revalidatePath("/saved");

  return { ok: true, active: result };
}

export async function toggleRead(itemId: string, active: boolean): Promise<ToggleResult> {
  return toggle(itemId, "READ", active);
}

export async function toggleSaved(itemId: string, active: boolean): Promise<ToggleResult> {
  return toggle(itemId, "SAVED", active);
}

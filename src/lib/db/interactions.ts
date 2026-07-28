import { type InteractionKind, type PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/db/client";

/** The kinds a user toggles deliberately, as opposed to ones the feed records. */
export type ToggleableKind = Extract<InteractionKind, "READ" | "SAVED">;

/** Per-user interaction state for a set of items. */
export interface ItemInteractions {
  read: Set<string>;
  saved: Set<string>;
}

export const EMPTY_INTERACTIONS: ItemInteractions = {
  read: new Set<string>(),
  saved: new Set<string>(),
};

/**
 * Sets or clears one interaction for one user and item.
 *
 * Idempotent by way of the `@@unique([userId, itemId, kind])` constraint —
 * marking read twice is one row, not two, and the second call is not an error.
 * Returns the resulting state so a caller can reconcile optimistic UI.
 */
export async function setInteraction(
  userId: string,
  itemId: string,
  kind: ToggleableKind,
  active: boolean,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  if (active) {
    await client.interaction.upsert({
      where: { userId_itemId_kind: { userId, itemId, kind } },
      create: { userId, itemId, kind },
      update: {},
    });
    return true;
  }

  // deleteMany rather than delete: removing a row that is already absent is the
  // requested end state, not a failure.
  await client.interaction.deleteMany({ where: { userId, itemId, kind } });
  return false;
}

/**
 * Reads read/saved state for the given items in one query.
 *
 * Scoped to the item ids on screen rather than fetching the user's whole
 * history, which grows without bound while a feed page does not.
 */
export async function getItemInteractions(
  userId: string,
  itemIds: string[],
  client: PrismaClient = defaultPrisma,
): Promise<ItemInteractions> {
  if (itemIds.length === 0) return { read: new Set(), saved: new Set() };

  const rows = await client.interaction.findMany({
    where: { userId, itemId: { in: itemIds }, kind: { in: ["READ", "SAVED"] } },
    select: { itemId: true, kind: true },
  });

  const read = new Set<string>();
  const saved = new Set<string>();
  for (const row of rows) {
    if (row.kind === "READ") read.add(row.itemId);
    else if (row.kind === "SAVED") saved.add(row.itemId);
  }

  return { read, saved };
}

/** Item ids the user has saved, newest first. Drives the /saved view. */
export async function getSavedItemIds(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<string[]> {
  const rows = await client.interaction.findMany({
    where: { userId, kind: "SAVED" },
    orderBy: { at: "desc" },
    select: { itemId: true },
  });

  return rows.map((row) => row.itemId);
}

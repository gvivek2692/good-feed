/**
 * Per-user state lives in unique constraints and real queries, so these run
 * against real Postgres rather than a mock. Skipped when DATABASE_URL is absent.
 * @vitest-environment node
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { getItemInteractions, getSavedItemIds, setInteraction } from "@/lib/db/interactions";

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const PREFIX = "interactions-test";

describeDb("interactions", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString! }),
  });

  let userId = "";
  let otherUserId = "";
  let itemA = "";
  let itemB = "";

  async function cleanup(): Promise<void> {
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.source.deleteMany({ where: { externalId: { startsWith: PREFIX } } });
  }

  beforeEach(async () => {
    await cleanup();

    const user = await prisma.user.create({ data: { email: `${PREFIX}-a@example.com` } });
    const other = await prisma.user.create({ data: { email: `${PREFIX}-b@example.com` } });
    userId = user.id;
    otherUserId = other.id;

    // Two items, each needing its own Source row.
    const ids: string[] = [];
    for (const suffix of ["a", "b"]) {
      const source = await prisma.source.create({
        data: {
          kind: "ARXIV",
          externalId: `${PREFIX}-${suffix}`,
          url: `https://arxiv.org/abs/${suffix}`,
          rawPayload: {},
        },
      });
      const item = await prisma.item.create({
        data: {
          sourceId: source.id,
          title: `Item ${suffix}`,
          authors: [],
          publishedAt: new Date("2026-07-27T12:00:00Z"),
          canonicalUrl: `https://arxiv.org/abs/${suffix}`,
          published: true,
        },
      });
      ids.push(item.id);
    }
    [itemA, itemB] = ids;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("marks an item read and reads it back", async () => {
    await setInteraction(userId, itemA, "READ", true, prisma);

    const state = await getItemInteractions(userId, [itemA, itemB], prisma);

    expect(state.read.has(itemA)).toBe(true);
    expect(state.read.has(itemB)).toBe(false);
    expect(state.saved.has(itemA)).toBe(false);
  });

  /**
   * The unique constraint is what makes this safe — a double-click, a retried
   * request, or a duplicated form submission must not create a second row.
   */
  it("is idempotent when the same interaction is set twice", async () => {
    await setInteraction(userId, itemA, "SAVED", true, prisma);
    await setInteraction(userId, itemA, "SAVED", true, prisma);

    const count = await prisma.interaction.count({
      where: { userId, itemId: itemA, kind: "SAVED" },
    });

    expect(count).toBe(1);
  });

  it("clears an interaction, and clearing an absent one is not an error", async () => {
    await setInteraction(userId, itemA, "SAVED", true, prisma);
    await setInteraction(userId, itemA, "SAVED", false, prisma);
    // Second clear: the end state is already correct, so this must not throw.
    await setInteraction(userId, itemA, "SAVED", false, prisma);

    const state = await getItemInteractions(userId, [itemA], prisma);
    expect(state.saved.has(itemA)).toBe(false);
  });

  /** Read and saved are independent — "done with it" and "keep it" both apply. */
  it("tracks read and saved independently for the same item", async () => {
    await setInteraction(userId, itemA, "READ", true, prisma);
    await setInteraction(userId, itemA, "SAVED", true, prisma);
    await setInteraction(userId, itemA, "READ", false, prisma);

    const state = await getItemInteractions(userId, [itemA], prisma);

    expect(state.read.has(itemA)).toBe(false);
    expect(state.saved.has(itemA)).toBe(true);
  });

  /**
   * The whole point of putting this behind auth: one user's state must never
   * leak into another's feed.
   */
  it("keeps one user's state out of another's", async () => {
    await setInteraction(userId, itemA, "READ", true, prisma);

    const mine = await getItemInteractions(userId, [itemA], prisma);
    const theirs = await getItemInteractions(otherUserId, [itemA], prisma);

    expect(mine.read.has(itemA)).toBe(true);
    expect(theirs.read.has(itemA)).toBe(false);
  });

  /**
   * The `at` values are set explicitly rather than by writing back to back:
   * measured, two consecutive inserts can share a millisecond, which would make
   * an ordering assertion pass or fail on timing luck.
   */
  it("returns saved ids newest first", async () => {
    await setInteraction(userId, itemA, "SAVED", true, prisma);
    await setInteraction(userId, itemB, "SAVED", true, prisma);
    await prisma.interaction.update({
      where: { userId_itemId_kind: { userId, itemId: itemA, kind: "SAVED" } },
      data: { at: new Date("2026-07-20T00:00:00Z") },
    });
    await prisma.interaction.update({
      where: { userId_itemId_kind: { userId, itemId: itemB, kind: "SAVED" } },
      data: { at: new Date("2026-07-25T00:00:00Z") },
    });

    const saved = await getSavedItemIds(userId, prisma);

    expect(saved).toEqual([itemB, itemA]);
  });

  it("does no query and returns empty state for an empty item list", async () => {
    const state = await getItemInteractions(userId, [], prisma);

    expect(state.read.size).toBe(0);
    expect(state.saved.size).toBe(0);
  });
});

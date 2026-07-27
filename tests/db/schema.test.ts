/**
 * Server-side code needs the node environment, not the jsdom default.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

/**
 * Integration tests against the local Postgres from docker-compose.yml.
 * Skipped when DATABASE_URL is absent so the unit suite stays runnable
 * without a database.
 */
const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb("database schema", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString! }),
  });

  it("has the 15 seeded topics, each with a unique slug", async () => {
    const topics = await prisma.topic.findMany();
    const slugs = new Set(topics.map((t) => t.slug));

    expect(topics).toHaveLength(15);
    expect(slugs.size).toBe(15);
  });

  it("stores embeddings as vector(1536) so pgvector can index them", async () => {
    // pgvector's HNSW/IVFFlat indexes cap at 2000 dimensions. Gemini returns
    // 3072 by default, so embed calls must request outputDimensionality=1536.
    // atttypmod carries the declared dimension.
    const [{ atttypmod }] = await prisma.$queryRaw<Array<{ atttypmod: number }>>`
      SELECT atttypmod FROM pg_attribute
      WHERE attrelid = '"Item"'::regclass AND attname = 'embedding'
    `;

    expect(atttypmod).toBe(1536);
    expect(atttypmod).toBeLessThanOrEqual(2000);
  });

  it("rejects a duplicate (kind, externalId) source", async () => {
    const externalId = `test-${Date.now()}`;
    const payload = {
      kind: "ARXIV" as const,
      externalId,
      url: "https://example.com",
      rawPayload: {},
    };

    await prisma.source.create({ data: payload });
    await expect(prisma.source.create({ data: payload })).rejects.toThrow();

    await prisma.source.deleteMany({ where: { externalId } });
  });
});

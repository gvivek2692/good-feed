import "@/lib/env";
import { prisma } from "@/lib/db/client";
import { getOrCreateDeepDive } from "@/lib/db/deep-dive";

/**
 * Generates a deep dive for the top feed items and prints them.
 *
 * The check mocks cannot make: whether the writing is actually readable, the
 * right length, and free of the register failures the prompt warns against.
 * Run with: npx tsx scripts/check-deep-dive.mts [count]
 */
async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 2);
  const items = await prisma.item.findMany({
    where: { published: true },
    orderBy: { importanceScore: "desc" },
    take: count,
  });

  for (const item of items) {
    console.log(`\n${"=".repeat(76)}`);
    console.log(`${item.headline ?? item.title}`);
    console.log("=".repeat(76));

    const started = Date.now();
    const result = await getOrCreateDeepDive(item.id);
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    if (!result.ok) {
      console.log(`FAILED (${secs}s): ${JSON.stringify(result.error).slice(0, 200)}`);
      continue;
    }

    const words = result.value.content.trim().split(/\s+/).length;
    console.log(`${words} words · ~${Math.max(1, Math.round(words / 250))} min · ${secs}s\n`);
    console.log(result.value.content);

    const banned = [
      "delve",
      "leverage",
      "harness",
      "revolution",
      "game-chang",
      "cutting-edge",
      "rapidly evolving",
      "landscape",
    ];
    const found = banned.filter((w) => result.value.content.toLowerCase().includes(w));
    if (found.length > 0) console.log(`\n!! BANNED PHRASES: ${found.join(", ")}`);
  }

  await prisma.$disconnect();
}
void main();

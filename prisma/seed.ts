import "dotenv/config";

import { prisma } from "../src/lib/db/client";
import { TOPICS } from "../src/lib/topics/taxonomy";

async function main(): Promise<void> {
  // Upsert keyed on slug, so re-running updates labels without duplicating rows.
  for (const topic of TOPICS) {
    await prisma.topic.upsert({
      where: { slug: topic.slug },
      update: { label: topic.label },
      create: topic,
    });
  }

  const count = await prisma.topic.count();
  console.log(`Seeded ${TOPICS.length} topics. Total in database: ${count}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

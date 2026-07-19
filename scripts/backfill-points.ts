/**
 * One-off backfill: legacy paise balances → Prinsta Points.
 *
 * Run once, after `prisma db push` has added the new columns and before the
 * points UI goes live:
 *
 *     npx tsx scripts/backfill-points.ts
 *
 * Safe to re-run. Only rows whose points column is still 0 while the legacy
 * paise column holds a value are touched, so a second run is a no-op and a
 * balance earned after the first run is never overwritten.
 */
import { prisma } from "../src/lib/prisma";
import { paiseToPoints, PAISE_PER_POINT } from "../src/lib/points";

async function backfillUsers(): Promise<number> {
  const users = await prisma.user.findMany({
    where: { pointsBalance: 0, pointsBalancePaise: { gt: 0 } },
    select: { id: true, pointsBalancePaise: true },
  });

  for (const u of users) {
    await prisma.user.update({
      where: { id: u.id },
      data: { pointsBalance: paiseToPoints(u.pointsBalancePaise) },
    });
  }
  return users.length;
}

async function backfillTransactions(): Promise<number> {
  const txns = await prisma.pointsTransaction.findMany({
    where: { amountPoints: 0, amountPaise: { gt: 0 } },
    select: { id: true, amountPaise: true, balancePaise: true },
  });

  for (const t of txns) {
    await prisma.pointsTransaction.update({
      where: { id: t.id },
      data: {
        amountPoints: paiseToPoints(t.amountPaise),
        balancePoints: paiseToPoints(t.balancePaise),
      },
    });
  }
  return txns.length;
}

async function main() {
  console.log(`Backfilling at ${PAISE_PER_POINT} paise per point…`);
  const users = await backfillUsers();
  const txns = await backfillTransactions();
  console.log(`Done. Converted ${users} user balance(s) and ${txns} transaction(s).`);
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

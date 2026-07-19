/**
 * One-off backfill: give every shop owner a Vendor row, and attach their
 * printers to it.
 *
 * Run once, after `prisma db push` has added the new tables:
 *
 *     npx tsx scripts/backfill-vendors.ts
 *
 * Safe to re-run — every step skips rows it has already done.
 *
 * Printers predate ownership entirely, so there is nothing authoritative to
 * match them on. The only signal is Printer.emailAddress, the free-text contact
 * that was captured when the printer was registered. Where that matches a vendor
 * account's email, the printer is assigned; where it doesn't, the printer is
 * left unassigned and reported, for an admin to attach by hand. Guessing on a
 * weaker signal (shop name, say) would hand someone else's machine — and its
 * revenue — to the wrong account.
 */
import { prisma } from "../src/lib/prisma";

/** OPERATOR was the old name for a shop owner. Move those accounts to VENDOR. */
async function migrateRoles(): Promise<number> {
  const { count } = await prisma.user.updateMany({
    where: { role: "OPERATOR" },
    data: { role: "VENDOR" },
  });
  return count;
}

/** Every vendor account needs exactly one Vendor row. */
async function createVendorRows(): Promise<number> {
  const users = await prisma.user.findMany({
    where: { role: "VENDOR", vendor: { is: null } },
    select: { id: true, name: true, phone: true },
  });

  for (const u of users) {
    await prisma.vendor.create({
      data: {
        userId: u.id,
        shopName: u.name || "My shop",
        contactName: u.name,
        mobileNumber: u.phone,
      },
    });
  }
  return users.length;
}

/**
 * Attach printers to vendors by matching the printer's recorded contact email
 * against the vendor account's email. Returns how many were assigned and how
 * many could not be matched.
 */
async function attachPrinters(): Promise<{ assigned: number; unmatched: string[] }> {
  const printers = await prisma.printer.findMany({
    where: { vendorId: null },
    select: { id: true, uniquePrinterId: true, emailAddress: true, shopName: true, locationName: true },
  });

  let assigned = 0;
  const unmatched: string[] = [];

  for (const p of printers) {
    const email = p.emailAddress?.trim().toLowerCase();
    const vendor = email
      ? await prisma.vendor.findFirst({ where: { user: { email } }, select: { id: true } })
      : null;

    if (!vendor) {
      unmatched.push(`${p.uniquePrinterId} (${p.shopName || "no shop name"})`);
      continue;
    }

    // Give the printer a Location too — its existing locationName is the best
    // description of where it stands. Reuse one of the same name so several
    // printers at one branch don't each invent their own.
    const name = p.locationName?.trim() || p.shopName?.trim() || "Main branch";
    const location =
      (await prisma.location.findFirst({ where: { vendorId: vendor.id, name }, select: { id: true } })) ??
      (await prisma.location.create({ data: { vendorId: vendor.id, name }, select: { id: true } }));

    await prisma.printer.update({
      where: { id: p.id },
      data: { vendorId: vendor.id, locationId: location.id },
    });
    assigned++;
  }

  return { assigned, unmatched };
}

/** Stamp historical orders with the vendor that owns the printer they ran on. */
async function backfillOrders(): Promise<number> {
  const orders = await prisma.order.findMany({
    where: { vendorId: null, printerId: { not: null } },
    select: { id: true, printer: { select: { vendorId: true, locationId: true } } },
  });

  let updated = 0;
  for (const o of orders) {
    if (!o.printer?.vendorId) continue;
    await prisma.order.update({
      where: { id: o.id },
      data: { vendorId: o.printer.vendorId, locationId: o.printer.locationId },
    });
    updated++;
  }
  return updated;
}

async function main() {
  const roles = await migrateRoles();
  const vendors = await createVendorRows();
  const { assigned, unmatched } = await attachPrinters();
  const orders = await backfillOrders();

  console.log(`Roles moved OPERATOR → VENDOR: ${roles}`);
  console.log(`Vendor rows created:           ${vendors}`);
  console.log(`Printers attached to a vendor: ${assigned}`);
  console.log(`Orders stamped with a vendor:  ${orders}`);

  if (unmatched.length) {
    console.log(`\n${unmatched.length} printer(s) could not be matched to a vendor account.`);
    console.log("Assign these by hand from the admin console:");
    for (const p of unmatched) console.log("  - " + p);
  }
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

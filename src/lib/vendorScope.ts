// Who owns what, for the vendor console.
//
// Printer routes used to be ADMIN-only, because a printer recorded its owner as
// free text and there was no way to ask "is this one yours?". Now that Printer
// has a vendorId, that question has an answer, and these helpers are where it
// gets asked.
import type { Response } from "express";
import { prisma } from "./prisma";
import type { AuthedRequest } from "../middleware/authGuard";

/** OPERATOR is the old name for VENDOR; both still appear on live rows. */
export function isVendorRole(role?: string): boolean {
  return role === "VENDOR" || role === "OPERATOR";
}

export function isAdminRole(role?: string): boolean {
  return role === "ADMIN";
}

/** The Vendor row for a signed-in vendor account, or null for anyone else. */
export async function vendorIdFor(userId: string): Promise<string | null> {
  const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
  return vendor?.id ?? null;
}

/**
 * Resolve the caller's vendor, replying 403 and returning null when they aren't
 * a vendor at all. Callers should return immediately on null.
 *
 * An account with no Vendor row gets one here rather than an error: accounts
 * created before vendors existed, and any the backfill couldn't reach, would
 * otherwise be locked out of their own console with nothing they could do about
 * it. Creating a shop profile for your own account is not a privileged act.
 */
export async function requireVendorId(req: AuthedRequest, res: Response): Promise<string | null> {
  if (!isVendorRole(req.user?.role)) {
    res.status(403).json({ error: "This is a vendor-only action." });
    return null;
  }

  const userId = req.user!.userId;
  const existing = await vendorIdFor(userId);
  if (existing) return existing;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, phone: true } });
  const created = await prisma.vendor.create({
    data: {
      userId,
      shopName: user?.name || "My shop",
      contactName: user?.name,
      mobileNumber: user?.phone,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * A `where` fragment that limits a query to what the caller may see: everything
 * for an admin, only their own for a vendor.
 */
export async function ownedPrinterFilter(req: AuthedRequest): Promise<{ vendorId?: string } | null> {
  if (isAdminRole(req.user?.role)) return {};
  if (!isVendorRole(req.user?.role)) return null; // not a console user
  const id = await vendorIdFor(req.user!.userId);
  // A vendor with no profile owns nothing — match no rows rather than all of them.
  return { vendorId: id ?? "__none__" };
}

/**
 * Check the caller may modify this printer. Replies 404 (not 403) when a vendor
 * reaches for someone else's machine — whether that id exists is not their
 * business.
 */
export async function assertCanManagePrinter(
  req: AuthedRequest,
  res: Response,
  printerId: string,
): Promise<boolean> {
  const printer = await prisma.printer.findUnique({
    where: { id: printerId },
    select: { vendorId: true },
  });
  if (!printer) {
    res.status(404).json({ error: "Printer not found" });
    return false;
  }
  if (isAdminRole(req.user?.role)) return true;

  const id = await vendorIdFor(req.user!.userId);
  if (!id || printer.vendorId !== id) {
    res.status(404).json({ error: "Printer not found" });
    return false;
  }
  return true;
}

/** Confirm a location belongs to this vendor before a printer is put in it. */
export async function locationBelongsToVendor(locationId: string, vendorId: string): Promise<boolean> {
  const loc = await prisma.location.findFirst({
    where: { id: locationId, vendorId },
    select: { id: true },
  });
  return !!loc;
}

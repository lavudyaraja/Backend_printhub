// Vendor profile and branch locations, for the vendor console.
//
// A vendor is a shop owner; a location is one of the places they operate from.
// Printers hang off a location, which is what makes "the same printer model at
// three different branches" unambiguous — three Printer rows, three locations,
// one vendor, and a scanned QR that resolves to exactly one of them.
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/authGuard";
import { requireVendorId, vendorIdFor, isVendorRole } from "../lib/vendorScope";

export const vendorsRouter = Router();

// ── The signed-in vendor's own profile ───────────────────────────────────────
vendorsRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  if (!isVendorRole(req.user?.role)) {
    return res.status(403).json({ error: "This is a vendor-only action." });
  }
  const vendor = await prisma.vendor.findUnique({
    where: { userId: req.user!.userId },
    include: {
      locations: {
        orderBy: { createdAt: "asc" },
        include: { _count: { select: { printers: true } } },
      },
      _count: { select: { printers: true, orders: true } },
    },
  });
  // Null rather than 404: the console renders a "finish setting up" state, and a
  // 404 here would read as a broken endpoint.
  res.json({ vendor });
});

const profileSchema = z.object({
  shopName: z.string().min(2, "Enter your shop name"),
  contactName: z.string().min(2).optional(),
  mobileNumber: z.string().min(10).optional(),
});

/** Create the vendor profile on first use, or update it later. */
vendorsRouter.put("/me", requireAuth, async (req: AuthedRequest, res) => {
  if (!isVendorRole(req.user?.role)) {
    return res.status(403).json({ error: "This is a vendor-only action." });
  }
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message });

  const userId = req.user!.userId;
  const vendor = await prisma.vendor.upsert({
    where: { userId },
    create: { userId, ...parsed.data },
    update: parsed.data,
  });
  res.json({ vendor });
});

// ── Locations ────────────────────────────────────────────────────────────────
const locationSchema = z.object({
  name: z.string().min(2, "Enter a name for this branch"),
  address: z.string().optional(),
});

vendorsRouter.get("/me/locations", requireAuth, async (req: AuthedRequest, res) => {
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return;

  const locations = await prisma.location.findMany({
    where: { vendorId },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { printers: true } } },
  });
  res.json({ locations });
});

vendorsRouter.post("/me/locations", requireAuth, async (req: AuthedRequest, res) => {
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return;

  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message });

  const location = await prisma.location.create({ data: { vendorId, ...parsed.data } });
  res.status(201).json({ location });
});

vendorsRouter.put("/me/locations/:id", requireAuth, async (req: AuthedRequest, res) => {
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return;

  const parsed = locationSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message });

  // Scoped by vendorId as well as id, so one vendor can't rename another's branch.
  const { count } = await prisma.location.updateMany({
    where: { id: req.params.id, vendorId },
    data: parsed.data,
  });
  if (count === 0) return res.status(404).json({ error: "Location not found" });

  const location = await prisma.location.findUnique({ where: { id: req.params.id } });
  res.json({ location });
});

vendorsRouter.delete("/me/locations/:id", requireAuth, async (req: AuthedRequest, res) => {
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return;

  // Deleting a branch would orphan its printers (locationId is SetNull), leaving
  // machines that belong nowhere. Make the vendor move them first.
  const printers = await prisma.printer.count({ where: { locationId: req.params.id } });
  if (printers > 0) {
    return res.status(409).json({
      error: `This branch still has ${printers} printer(s). Move or remove them first.`,
    });
  }

  const { count } = await prisma.location.deleteMany({ where: { id: req.params.id, vendorId } });
  if (count === 0) return res.status(404).json({ error: "Location not found" });
  res.json({ deleted: true });
});

// ── Admin: every vendor on the platform ──────────────────────────────────────
vendorsRouter.get("/", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { search, limit = "50", offset = "0" } = req.query as Record<string, string>;

  const where = search
    ? {
        OR: [
          { shopName: { contains: search, mode: "insensitive" as const } },
          { user: { email: { contains: search, mode: "insensitive" as const } } },
        ],
      }
    : {};

  const [vendors, total] = await Promise.all([
    prisma.vendor.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        locations: { select: { id: true, name: true } },
        _count: { select: { printers: true, orders: true } },
      },
    }),
    prisma.vendor.count({ where }),
  ]);

  res.json({ vendors, total });
});

/** Admin: attach a printer that the backfill couldn't match to a vendor. */
vendorsRouter.post("/:id/printers/:printerId", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });

  try {
    const printer = await prisma.printer.update({
      where: { id: req.params.printerId },
      // The old location belonged to whoever owned it before; clear it so the
      // new vendor picks one of their own branches.
      data: { vendorId: vendor.id, locationId: null },
    });
    res.json({ printer });
  } catch (e: any) {
    if (e.code === "P2025") return res.status(404).json({ error: "Printer not found" });
    throw e;
  }
});

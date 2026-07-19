import { Router } from "express";
import { z } from "zod";
import QRCode from "qrcode";
import { nanoid } from "nanoid";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthedRequest } from "../middleware/authGuard";
import {
  isAdminRole,
  isVendorRole,
  requireVendorId,
  ownedPrinterFilter,
  assertCanManagePrinter,
  locationBelongsToVendor,
} from "../lib/vendorScope";

export const printersRouter = Router();

function generatePrinterId() {
  return "PRN-" + nanoid(6).toUpperCase();
}

async function generateQR(printerId: string): Promise<{ qrData: string; qrCode: string }> {
  const appUrl = process.env.APP_URL || "https://prinsta.app";
  const qrData = `${appUrl}/connect?printer=${printerId}`;
  const qrCode = await QRCode.toDataURL(qrData, {
    width: 300,
    margin: 2,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  return { qrData, qrCode };
}

const printerSchema = z.object({
  name: z.string().min(2),
  brand: z.string().min(1),
  model: z.string().min(1),
  serialNumber: z.string().optional(),
  ipAddress: z.string().min(7),
  macAddress: z.string().optional(),
  wifiSsid: z.string().optional(),
  accessPassword: z.string().optional(),
  locationName: z.string().min(2),
  shopName: z.string().min(2),
  ownerName: z.string().min(2),
  mobileNumber: z.string().min(10),
  emailAddress: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  supportedPaperSizes: z.array(z.string()).default(["A4"]),
  colorPrinting: z.boolean().default(false),
  duplexPrinting: z.boolean().default(false),
  costPerBWPagePaise: z.number().int().min(0).default(200),
  costPerColorPagePaise: z.number().int().min(0).default(1000),
  status: z.enum(["ONLINE", "OFFLINE", "BUSY", "ERROR", "OUT_OF_PAPER", "LOW_TONER"]).optional(),
  /** Which of the vendor's branches this machine stands in. */
  locationId: z.string().optional(),
});

// ── List printers (auth required) ─────────────────────────────────────────────
// Students see every printer — that's how they find one near them. A vendor sees
// only their own, so one shop can't read another's estate. An admin sees all.
printersRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const { status, search, limit = "50", offset = "0" } = req.query as Record<string, string>;
  const scope = isVendorRole(req.user?.role) ? await ownedPrinterFilter(req) : {};

  const printers = await prisma.printer.findMany({
    where: {
      ...scope,
      ...(status ? { status: status as any } : {}),
      ...(search ? {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { shopName: { contains: search, mode: "insensitive" } },
          { locationName: { contains: search, mode: "insensitive" } },
          { uniquePrinterId: { contains: search, mode: "insensitive" } },
        ],
      } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(parseInt(limit) || 50, 200),
    skip: parseInt(offset) || 0,
    select: {
      id: true, uniquePrinterId: true, name: true, brand: true, model: true,
      ipAddress: true, status: true, locationName: true, shopName: true, ownerName: true,
      mobileNumber: true, colorPrinting: true, duplexPrinting: true,
      costPerBWPagePaise: true, costPerColorPagePaise: true,
      supportedPaperSizes: true, paperLevel: true, tonerLevel: true,
      lastSeenAt: true, createdAt: true,
      vendorId: true, locationId: true,
      location: { select: { id: true, name: true } },
      _count: { select: { orders: true } },
    },
  });
  const total = await prisma.printer.count({
    where: {
      ...scope,
      ...(status ? { status: status as any } : {}),
      ...(search ? {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { shopName: { contains: search, mode: "insensitive" } },
        ],
      } : {}),
    },
  });
  res.json({ printers, total });
});

// ── Connect to a printer via its QR code (mobile app) ──────────────────────────
// The QR encodes the printer's uniquePrinterId (e.g. PRN-AB12CD). The app scans
// it, looks the printer up here, and shows "<Brand> Printer Connected". The WiFi
// printer's reachability is implicit — registration already stored its network
// details, so "connecting" is just identifying the registered printer.
printersRouter.get("/connect/:uniquePrinterId", requireAuth, async (req, res) => {
  const printer = await prisma.printer.findUnique({
    where: { uniquePrinterId: req.params.uniquePrinterId.toUpperCase() },
    select: {
      id: true, uniquePrinterId: true, name: true, brand: true, model: true,
      status: true, locationName: true, shopName: true,
      supportedPaperSizes: true, colorPrinting: true, duplexPrinting: true,
      costPerBWPagePaise: true, costPerColorPagePaise: true,
      // Network details the app uses to join the printer's Wi-Fi Direct and send
      // the IPP print job directly (no discovery — everything comes from here).
      ipAddress: true, wifiSsid: true, accessPassword: true,
    },
  });
  if (!printer) {
    return res.status(404).json({ error: "Printer not found. Please scan a valid Prinsta printer QR." });
  }
  // Note: we intentionally do NOT block on status === "OFFLINE" here. The app
  // prints directly over the printer's own Wi-Fi Direct (SoftAP) — reachability
  // is proven by the phone joining that network and the IPP job succeeding, not
  // by the backend-tracked status (which defaults to OFFLINE at registration and
  // is only updated by an agent/admin). Blocking here made every freshly
  // registered printer un-connectable ("connection failed") even though it was
  // perfectly printable. Only ERROR-class states are surfaced as a hard block.
  if (printer.status === "ERROR" || printer.status === "OUT_OF_PAPER") {
    return res.status(503).json({
      error:
        printer.status === "OUT_OF_PAPER"
          ? "This printer is out of paper. Please try another one."
          : "This printer reported an error. Please try another one.",
      printer,
    });
  }
  res.json({ printer });
});

// ── Get single printer ─────────────────────────────────────────────────────────
printersRouter.get("/:id", requireAuth, async (req, res) => {
  const printer = await prisma.printer.findUnique({
    where: { id: req.params.id },
    include: {
      _count: { select: { orders: true, printJobs: true } },
      orders: {
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, orderCode: true, status: true, costPaise: true, createdAt: true },
      },
    },
  });
  if (!printer) return res.status(404).json({ error: "Printer not found" });
  // Never expose the printer access password in API responses.
  const { accessPassword, ...safe } = printer as typeof printer & { accessPassword?: string | null };
  res.json({ printer: safe });
});

// ── Register printer ──────────────────────────────────────────────────────────
// A vendor registers their own machines; the new printer is attached to them
// automatically, so nobody can register a printer into someone else's estate.
// An admin may also register on a vendor's behalf by passing vendorId.
printersRouter.post("/", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = printerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
  }
  const data = parsed.data;

  let vendorId: string | null;
  if (isAdminRole(req.user?.role)) {
    vendorId = typeof req.body.vendorId === "string" ? req.body.vendorId : null;
  } else {
    vendorId = await requireVendorId(req, res);
    if (!vendorId) return;
  }

  // A printer may only be placed in a branch its own vendor runs.
  if (data.locationId) {
    if (!vendorId || !(await locationBelongsToVendor(data.locationId, vendorId))) {
      return res.status(400).json({ error: "That location doesn't belong to this vendor." });
    }
  }

  const uniquePrinterId = generatePrinterId();
  const { qrData, qrCode } = await generateQR(uniquePrinterId);

  const printer = await prisma.printer.create({
    data: {
      uniquePrinterId,
      name: data.name,
      brand: data.brand,
      model: data.model,
      serialNumber: data.serialNumber || null,
      ipAddress: data.ipAddress,
      macAddress: data.macAddress || null,
      wifiSsid: data.wifiSsid || null,
      accessPassword: data.accessPassword || null,
      locationName: data.locationName,
      shopName: data.shopName,
      ownerName: data.ownerName,
      mobileNumber: data.mobileNumber,
      emailAddress: data.emailAddress || null,
      address: data.address || null,
      supportedPaperSizes: data.supportedPaperSizes,
      colorPrinting: data.colorPrinting,
      duplexPrinting: data.duplexPrinting,
      costPerBWPagePaise: data.costPerBWPagePaise,
      costPerColorPagePaise: data.costPerColorPagePaise,
      status: data.status || "OFFLINE",
      vendorId,
      locationId: data.locationId || null,
      qrData,
      qrCode,
    },
  });
  res.status(201).json({ printer });
});

// ── Update printer ────────────────────────────────────────────────────────────
// Admins may edit any printer; a vendor only their own.
printersRouter.put("/:id", requireAuth, async (req: AuthedRequest, res) => {
  if (!(await assertCanManagePrinter(req, res, req.params.id))) return;

  const parsed = printerSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
  }
  const data = parsed.data;

  if (data.locationId) {
    const current = await prisma.printer.findUnique({
      where: { id: req.params.id },
      select: { vendorId: true },
    });
    if (!current?.vendorId || !(await locationBelongsToVendor(data.locationId, current.vendorId))) {
      return res.status(400).json({ error: "That location doesn't belong to this printer's vendor." });
    }
  }

  try {
    const printer = await prisma.printer.update({
      where: { id: req.params.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.brand !== undefined ? { brand: data.brand } : {}),
        ...(data.model !== undefined ? { model: data.model } : {}),
        ...(data.serialNumber !== undefined ? { serialNumber: data.serialNumber } : {}),
        ...(data.ipAddress !== undefined ? { ipAddress: data.ipAddress } : {}),
        ...(data.macAddress !== undefined ? { macAddress: data.macAddress } : {}),
        ...(data.wifiSsid !== undefined ? { wifiSsid: data.wifiSsid || null } : {}),
        ...(data.accessPassword !== undefined ? { accessPassword: data.accessPassword || null } : {}),
        ...(data.locationName !== undefined ? { locationName: data.locationName } : {}),
        ...(data.shopName !== undefined ? { shopName: data.shopName } : {}),
        ...(data.ownerName !== undefined ? { ownerName: data.ownerName } : {}),
        ...(data.mobileNumber !== undefined ? { mobileNumber: data.mobileNumber } : {}),
        ...(data.emailAddress !== undefined ? { emailAddress: data.emailAddress || null } : {}),
        ...(data.address !== undefined ? { address: data.address } : {}),
        ...(data.supportedPaperSizes !== undefined ? { supportedPaperSizes: data.supportedPaperSizes } : {}),
        ...(data.colorPrinting !== undefined ? { colorPrinting: data.colorPrinting } : {}),
        ...(data.duplexPrinting !== undefined ? { duplexPrinting: data.duplexPrinting } : {}),
        ...(data.costPerBWPagePaise !== undefined ? { costPerBWPagePaise: data.costPerBWPagePaise } : {}),
        ...(data.costPerColorPagePaise !== undefined ? { costPerColorPagePaise: data.costPerColorPagePaise } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.locationId !== undefined ? { locationId: data.locationId || null } : {}),
      },
    });
    res.json({ printer });
  } catch (e: any) {
    if (e.code === "P2025") return res.status(404).json({ error: "Printer not found" });
    throw e;
  }
});

// ── Regenerate QR ─────────────────────────────────────────────────────────────
printersRouter.post("/:id/regenerate-qr", requireAuth, async (req: AuthedRequest, res) => {
  if (!(await assertCanManagePrinter(req, res, req.params.id))) return;

  const printer = await prisma.printer.findUnique({ where: { id: req.params.id } });
  if (!printer) return res.status(404).json({ error: "Printer not found" });

  const { qrData, qrCode } = await generateQR(printer.uniquePrinterId);
  const updated = await prisma.printer.update({
    where: { id: req.params.id },
    data: { qrData, qrCode },
  });
  res.json({ printer: updated });
});

// ── Delete printer ────────────────────────────────────────────────────────────
printersRouter.delete("/:id", requireAuth, async (req: AuthedRequest, res) => {
  if (!(await assertCanManagePrinter(req, res, req.params.id))) return;

  try {
    await prisma.printer.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (e: any) {
    if (e.code === "P2025") return res.status(404).json({ error: "Printer not found" });
    throw e;
  }
});

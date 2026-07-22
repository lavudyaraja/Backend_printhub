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

/**
 * Escape the characters the WIFI: QR format treats as delimiters, so an SSID or
 * password containing `;`, `:`, `,`, `"` or `\` still decodes cleanly. The app's
 * parser (printerQr.ts) unescapes the same set.
 */
function escapeWifiValue(v: string): string {
  return v.replace(/([\\;,:"])/g, "\\$1");
}

interface QrSource {
  uniquePrinterId: string;
  wifiSsid?: string | null;
  accessPassword?: string | null;
}

/**
 * Build a printer's QR.
 *
 * When the machine has Wi-Fi Direct details, the QR is a *standard Wi-Fi QR*
 * (`WIFI:S:…;T:WPA;P:…;;`) — the app reads it, joins the printer's own network
 * and prints straight away, with no backend round-trip and nothing to type. This
 * is what makes "scan → connected → print" work from the sticker we generate,
 * not only from the printer's factory sticker.
 *
 * A printer with no network details yet falls back to the identity URL, so a
 * half-registered machine still gets a scannable code rather than none.
 */
async function generateQR(src: QrSource): Promise<{ qrData: string; qrCode: string }> {
  // A JSON payload carrying BOTH the unique printer id and the Wi-Fi Direct
  // credentials. The id is what links an order to the exact machine — identical
  // printers at different shops share the same SSID, so the SSID alone can't tell
  // them apart. The app parses this JSON (see printerQr.ts): it joins the network
  // with ssid/password and attaches the order with the id.
  const payload: Record<string, string> = { id: src.uniquePrinterId };
  if (src.wifiSsid) payload.ssid = src.wifiSsid;
  if (src.accessPassword) payload.password = src.accessPassword;
  const qrData = JSON.stringify(payload);

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
  // Required: the QR is the printer's Wi-Fi Direct network, so a machine with no
  // SSID would get a QR that can't connect. Enforced here so it can't happen.
  wifiSsid: z.string().min(2, "The printer's Wi-Fi Direct name (SSID) is required."),
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
      // The shop's star rating, so the app can show it next to each machine on
      // the pick-a-printer screen. This is the denormalized average on Vendor —
      // aggregating live here would mean a ratings scan per printer on the
      // busiest screen in the app.
      vendor: { select: { id: true, shopName: true, ratingAvg: true, ratingCount: true } },
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
  const { qrData, qrCode } = await generateQR({
    uniquePrinterId,
    wifiSsid: data.wifiSsid,
    accessPassword: data.accessPassword,
  });

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

  // A changed SSID or password makes the old QR connect to nothing, so rebuild it
  // from the machine's new details. Merged with what's on file, since either
  // field may be edited alone.
  let qrUpdate: { qrData: string; qrCode: string } | null = null;
  if (data.wifiSsid !== undefined || data.accessPassword !== undefined) {
    const current = await prisma.printer.findUnique({
      where: { id: req.params.id },
      select: { uniquePrinterId: true, wifiSsid: true, accessPassword: true },
    });
    if (current) {
      qrUpdate = await generateQR({
        uniquePrinterId: current.uniquePrinterId,
        wifiSsid: data.wifiSsid !== undefined ? data.wifiSsid || null : current.wifiSsid,
        accessPassword:
          data.accessPassword !== undefined ? data.accessPassword || null : current.accessPassword,
      });
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
        ...(qrUpdate ? { qrData: qrUpdate.qrData, qrCode: qrUpdate.qrCode } : {}),
      },
    });
    res.json({ printer });
  } catch (e: any) {
    if (e.code === "P2025") return res.status(404).json({ error: "Printer not found" });
    throw e;
  }
});

// ── Regenerate every owned printer's QR ───────────────────────────────────────
// One tap to reissue the whole estate's codes after the Wi-Fi-QR format change,
// so existing stickers start connecting instead of needing each printer edited.
// Declared before /:id/regenerate-qr is irrelevant (different path), but kept
// above it for readability. Admins reissue platform-wide; a vendor, their own.
printersRouter.post("/regenerate-all-qr", requireAuth, async (req: AuthedRequest, res) => {
  const scope = isAdminRole(req.user?.role) ? {} : await ownedPrinterFilter(req);
  if (!scope) return res.status(403).json({ error: "This is a vendor-only action." });

  const printers = await prisma.printer.findMany({
    where: scope,
    select: { id: true, uniquePrinterId: true, wifiSsid: true, accessPassword: true },
  });

  let updated = 0;
  for (const p of printers) {
    const { qrData, qrCode } = await generateQR(p);
    await prisma.printer.update({ where: { id: p.id }, data: { qrData, qrCode } });
    updated += 1;
  }
  res.json({ updated, total: printers.length });
});

// ── Regenerate one printer's QR ───────────────────────────────────────────────
printersRouter.post("/:id/regenerate-qr", requireAuth, async (req: AuthedRequest, res) => {
  if (!(await assertCanManagePrinter(req, res, req.params.id))) return;

  const printer = await prisma.printer.findUnique({ where: { id: req.params.id } });
  if (!printer) return res.status(404).json({ error: "Printer not found" });

  const { qrData, qrCode } = await generateQR({
    uniquePrinterId: printer.uniquePrinterId,
    wifiSsid: printer.wifiSsid,
    accessPassword: printer.accessPassword,
  });
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

// Orders: create order, preview page count, track, history.
// Payment removed — all orders are auto-confirmed (free printing).
import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthedRequest } from "../middleware/authGuard";
import { enqueuePrint, dispatchToPrinter } from "../services/printQueue";
import { createNotification } from "../lib/notify";
import { sendEmail, orderReceiptEmail } from "../lib/mailer";
import { debitWallet } from "./wallet";

export const ordersRouter = Router();

const BW_PAISE = Number(process.env.PRICE_BW_PAISE ?? 200);
const COLOR_PAISE = Number(process.env.PRICE_COLOR_PAISE ?? 1000);

// Count billable pages from a range string: "all" | "1-3,5" | "1,2,7".
function countPages(range: string, totalPages: number): number {
  const r = (range || "all").trim().toLowerCase();
  if (r === "all") return totalPages;
  const pages = new Set<number>();
  for (const part of r.split(",")) {
    const seg = part.trim();
    if (!seg) continue;
    if (seg.includes("-")) {
      const [a, b] = seg.split("-").map((n) => parseInt(n, 10));
      if (isNaN(a) || isNaN(b)) continue;
      for (let i = Math.max(1, a); i <= Math.min(totalPages, b); i++) pages.add(i);
    } else {
      const n = parseInt(seg, 10);
      if (!isNaN(n) && n >= 1 && n <= totalPages) pages.add(n);
    }
  }
  return pages.size || totalPages;
}

function calculateTotalCost(
  pageRange: string,
  pageColorModesStr: string | undefined | null,
  totalPages: number,
  copies: number
): number {
  const BW_PAISE = 200;
  const COLOR_PAISE = 1000;

  const range = (pageRange || "all").trim().toLowerCase();
  const selectedPages = new Set<number>();
  if (range === "all") {
    for (let i = 1; i <= totalPages; i++) selectedPages.add(i);
  } else {
    for (const part of range.split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      if (seg.includes("-")) {
        const [a, b] = seg.split("-").map((n) => parseInt(n, 10));
        if (!isNaN(a) && !isNaN(b)) {
          for (let i = Math.max(1, a); i <= Math.min(totalPages, b); i++) {
            selectedPages.add(i);
          }
        }
      } else {
        const n = parseInt(seg, 10);
        if (!isNaN(n) && n >= 1 && n <= totalPages) {
          selectedPages.add(n);
        }
      }
    }
  }

  const pageModes: Record<number, "BW" | "COLOR"> = {};
  if (pageColorModesStr) {
    for (const item of pageColorModesStr.split(",")) {
      const [pStr, mode] = item.trim().split(":");
      if (pStr && mode) {
        const p = parseInt(pStr, 10);
        if (!isNaN(p) && (mode === "BW" || mode === "COLOR")) {
          pageModes[p] = mode as "BW" | "COLOR";
        }
      }
    }
  }

  let totalCost = 0;
  selectedPages.forEach((p) => {
    const mode = pageModes[p] || "BW";
    totalCost += mode === "COLOR" ? COLOR_PAISE : BW_PAISE;
  });

  return totalCost * copies;
}

const configSchema = z.object({
  documentId: z.string(),
  colorMode: z.enum(["BW", "COLOR"]).default("BW"),
  sideMode: z.enum(["SINGLE", "DOUBLE"]).default("SINGLE"),
  copies: z.number().int().min(1).max(50).default(1),
  pageRange: z.string().default("all"),
  pageColorModes: z.string().optional(),
  printerId: z.string().optional(),
  payWithWallet: z.boolean().optional(), // deduct order cost from wallet balance
});

// Create order — immediately PAID (free printing, no payment step).
ordersRouter.post("/", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const c = parsed.data;

  const doc = await prisma.document.findFirst({
    where: { id: c.documentId, userId: req.user!.userId, deleted: false },
  });
  if (!doc) return res.status(404).json({ error: "Document not found" });

  const existing = await prisma.order.findUnique({ where: { documentId: doc.id } });
  if (existing) return res.status(409).json({ error: "Order already exists for this document" });

  const pagesToPrint = countPages(c.pageRange, doc.pageCount);
  const costPaise = calculateTotalCost(c.pageRange, c.pageColorModes, doc.pageCount, c.copies);

  let storedColorMode: "BW" | "COLOR" = "BW";
  if (c.pageColorModes) {
    const range = (c.pageRange || "all").trim().toLowerCase();
    const selectedPages = new Set<number>();
    if (range === "all") {
      for (let i = 1; i <= doc.pageCount; i++) selectedPages.add(i);
    } else {
      for (const part of range.split(",")) {
        const seg = part.trim();
        if (!seg) continue;
        if (seg.includes("-")) {
          const [a, b] = seg.split("-").map((n) => parseInt(n, 10));
          if (!isNaN(a) && !isNaN(b)) {
            for (let i = Math.max(1, a); i <= Math.min(doc.pageCount, b); i++) selectedPages.add(i);
          }
        } else {
          const n = parseInt(seg, 10);
          if (!isNaN(n) && n >= 1 && n <= doc.pageCount) selectedPages.add(n);
        }
      }
    }
    for (const item of c.pageColorModes.split(",")) {
      const [pStr, mode] = item.trim().split(":");
      if (pStr && mode === "COLOR") {
        const p = parseInt(pStr, 10);
        if (!isNaN(p) && selectedPages.has(p)) {
          storedColorMode = "COLOR";
          break;
        }
      }
    }
  } else {
    storedColorMode = c.colorMode;
  }

  const orderCode = "PH-" + nanoid(6).toUpperCase();
  const printToken = nanoid(40);
  const qrData = JSON.stringify({ code: orderCode, token: printToken });
  const qrImage = await QRCode.toDataURL(qrData);

  const order = await prisma.order.create({
    data: {
      orderCode,
      userId: req.user!.userId,
      documentId: doc.id,
      printerId: c.printerId,
      colorMode: storedColorMode,
      sideMode: c.sideMode,
      copies: c.copies,
      pageRange: c.pageRange,
      pageColorModes: c.pageColorModes,
      pagesToPrint,
      costPaise,
      printToken,
      qrData,
      status: "PAID", // free printing — skip payment entirely
    },
  });

  // Optional wallet payment: deduct the order cost from the prepaid balance.
  // If the balance is short, roll back the order and ask the user to top up.
  if (c.payWithWallet && costPaise > 0) {
    try {
      await debitWallet(order.userId, costPaise, `Print order ${order.orderCode}`, order.id);
    } catch (e: any) {
      await prisma.order.delete({ where: { id: order.id } });
      if (e.message === "INSUFFICIENT_FUNDS") {
        return res.status(402).json({ error: "Insufficient wallet balance. Please top up.", needTopup: true });
      }
      throw e;
    }
  }

  await createNotification(
    order.userId,
    "Order placed",
    `Order ${order.orderCode} created — scan your QR at any kiosk to print.`,
    order.id
  );

  // Order receipt email (best-effort — only if the buyer has an email on file).
  const buyer = await prisma.user.findUnique({ where: { id: order.userId } });
  if (buyer?.email) {
    const { subject, html } = orderReceiptEmail({
      name: buyer.name,
      orderCode: order.orderCode,
      pages: order.pagesToPrint,
      copies: order.copies,
      colorMode: order.colorMode,
      amountPaise: order.costPaise ?? 0,
    });
    sendEmail(buyer.email, subject, html);
  }

  // If a printer was pre-selected, enqueue immediately.
  if (c.printerId) await enqueuePrint(order.id);

  res.json({ order, qrImage });
});

// Track single order.
ordersRouter.get("/:id", requireAuth, async (req: AuthedRequest, res) => {
  const order = await prisma.order.findFirst({
    where: { id: req.params.id, userId: req.user!.userId },
    include: { document: true, printer: true, printJob: true },
  });
  if (!order) return res.status(404).json({ error: "Not found" });
  res.json({ order });
});

// Order history.
ordersRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const orders = await prisma.order.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: "desc" },
    include: { document: true },
  });
  res.json({ orders });
});

// Scan a kiosk QR (deviceId) to print an order at that kiosk.
// Binds the given order (or the user's latest printable one) to the scanned
// printer and starts printing.
ordersRouter.post("/print-at", requireAuth, async (req: AuthedRequest, res) => {
  const { deviceId, orderId } = req.body as { deviceId?: string; orderId?: string };
  if (!deviceId) return res.status(400).json({ error: "Missing kiosk code" });

  const printer = await prisma.printer.findUnique({ where: { deviceId } });
  if (!printer) return res.status(404).json({ error: "Kiosk not recognised" });
  if (!["ONLINE", "BUSY"].includes(printer.status)) {
    return res.status(409).json({ error: "This kiosk is offline right now" });
  }

  // Pick the order: explicit id, else the user's latest printable order.
  const order = orderId
    ? await prisma.order.findFirst({ where: { id: orderId, userId: req.user!.userId } })
    : await prisma.order.findFirst({
        where: { userId: req.user!.userId, status: { in: ["PAID", "READY"] } },
        orderBy: { createdAt: "desc" },
      });

  if (!order) return res.status(404).json({ error: "No order ready to print. Create one first." });
  if (!["PAID", "READY"].includes(order.status)) {
    return res.status(409).json({ error: `Order is already ${order.status.toLowerCase()}` });
  }

  await prisma.order.update({
    where: { id: order.id },
    data: { printerId: printer.id, status: "PAID" },
  });
  await dispatchToPrinter(order.id);

  res.json({ ok: true, orderId: order.id, kiosk: printer.name });
});

// User orders: create from an uploaded document, pay by wallet or UPI (Razorpay),
// verify payment, list & fetch orders. A PrintJob is queued once an order is PAID.
import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { prisma } from "../lib/prisma";
import { config, publicBaseUrl } from "../lib/config";
import { requireAuth, type AuthedRequest } from "../middleware/authGuard";
import { createRazorpayOrder, verifyPaymentSignature, checkoutPage } from "../lib/razorpay";

export const ordersRouter = Router();

const DEFAULT_BW = 200;
const DEFAULT_COLOR = 1000;

// Parse "1:BW,2:COLOR,5:COLOR" → [{page, mode}]
function parsePageModes(s: string): { page: number; mode: "BW" | "COLOR" }[] {
  return (s || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const [pg, mode] = pair.split(":");
      return { page: parseInt(pg, 10) || 1, mode: mode === "COLOR" ? "COLOR" : "BW" as "BW" | "COLOR" };
    });
}

const createSchema = z.object({
  tempKey: z.string().min(1),
  colorMode: z.enum(["BW", "COLOR"]).default("BW"),
  sideMode: z.enum(["SINGLE", "DOUBLE"]).default("SINGLE"),
  copies: z.number().int().min(1).max(50).default(1),
  pageRange: z.string().default("all"),
  pageColorModes: z.string().default(""),
  paperSize: z.string().default("A4"),
  printerId: z.string().optional(),
  paymentMethod: z.enum(["WALLET", "UPI", "CREDIT_CARD", "DEBIT_CARD", "NET_BANKING"]).default("WALLET"),
  payWithWallet: z.boolean().default(true),
});

// ── Create an order from an uploaded document ───────────────────────────────
ordersRouter.post("/from-temp", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
  const d = parsed.data;
  const userId = req.user!.userId;

  const doc = await prisma.document.findFirst({
    where: { id: d.tempKey, userId, deleted: false },
    include: { order: { select: { id: true, status: true } } },
  });
  if (!doc) return res.status(410).json({ error: "SESSION_EXPIRED" });
  // An unpaid (PENDING_PAYMENT) order means a previous UPI attempt was cancelled
  // or failed. It never created a PrintJob or moved money, so it is disposable —
  // clear it so the user can retry (possibly with changed options). Only a real,
  // committed order (PAID or beyond) blocks re-ordering the same document.
  if (doc.order) {
    if (doc.order.status === "PENDING_PAYMENT") {
      await prisma.order.delete({ where: { id: doc.order.id } });
    } else {
      return res.status(409).json({ error: "This document already has an order." });
    }
  }

  // Rates from the target printer (falls back to defaults).
  let bw = DEFAULT_BW, color = DEFAULT_COLOR;
  if (d.printerId) {
    const pr = await prisma.printer.findUnique({ where: { id: d.printerId }, select: { costPerBWPagePaise: true, costPerColorPagePaise: true } });
    if (pr) { bw = pr.costPerBWPagePaise; color = pr.costPerColorPagePaise; }
  }

  // Authoritative page set + cost.
  let modes = parsePageModes(d.pageColorModes);
  if (modes.length === 0) {
    modes = Array.from({ length: doc.pageCount }, (_, i) => ({ page: i + 1, mode: d.colorMode }));
  }
  const pagesToPrint = modes.length;
  const perCopy = modes.reduce((acc, m) => acc + (m.mode === "COLOR" ? color : bw), 0);
  const listPaise = perCopy * d.copies;
  const anyColor = modes.some((m) => m.mode === "COLOR");

  // Paying from the Prinsta wallet earns a discount; paying directly (UPI/card)
  // is charged the full rate. Computed here, on the server — the client's number
  // is only ever a preview.
  const payingFromWallet = d.payWithWallet || d.paymentMethod === "WALLET";
  const discountPaise = payingFromWallet
    ? Math.floor((listPaise * config.walletDiscountPercent) / 100)
    : 0;
  const costPaise = listPaise - discountPaise;

  const baseData = {
    orderCode: "PRT-" + nanoid(6).toUpperCase(),
    userId,
    documentId: doc.id,
    printerId: d.printerId || null,
    colorMode: (anyColor ? "COLOR" : "BW") as "BW" | "COLOR",
    sideMode: d.sideMode,
    copies: d.copies,
    pageRange: d.pageRange,
    pageColorModes: d.pageColorModes || null,
    pagesToPrint,
    paperSize: d.paperSize,
    costPaise,
    paymentMethod: d.paymentMethod,
    printToken: nanoid(16),
  };

  // ── Wallet payment ──
  if (d.payWithWallet || d.paymentMethod === "WALLET") {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { walletBalancePaise: true } });
    if (!user || user.walletBalancePaise < costPaise) {
      return res.status(402).json({ error: "INSUFFICIENT_FUNDS", requiredPaise: costPaise, balancePaise: user?.walletBalancePaise || 0 });
    }

    const order = await prisma.$transaction(async (tx) => {
      const o = await tx.order.create({ data: { ...baseData, paymentMethod: "WALLET", status: "PAID" } });
      const u = await tx.user.update({ where: { id: userId }, data: { walletBalancePaise: { decrement: costPaise } } });
      await tx.walletTransaction.create({
        data: { userId, type: "DEBIT", amountPaise: costPaise, balancePaise: u.walletBalancePaise, description: `Print order ${o.orderCode}`, orderId: o.id },
      });
      if (o.printerId) await tx.printJob.create({ data: { orderId: o.id, printerId: o.printerId, status: "QUEUED" } });
      return o;
    });

    return res.json({ order });
  }

  // ── Direct payment (UPI) → create a Razorpay order ──
  if (!config.razorpay.configured) {
    return res.status(503).json({ error: "Online payments are not enabled on the server yet." });
  }
  const order = await prisma.order.create({ data: { ...baseData, status: "PENDING_PAYMENT" } });
  const rz = await createRazorpayOrder(costPaise, order.orderCode, { orderId: order.id });
  const updated = await prisma.order.update({ where: { id: order.id }, data: { razorpayOrderId: rz.id } });

  res.json({ order: updated, razorpayOrderId: rz.id, keyId: config.razorpay.keyId, mode: config.razorpay.mode, amountPaise: costPaise });
});

// ── Hosted checkout page (opened in the app's WebView) ──────────────────────
ordersRouter.get("/checkout", async (req, res) => {
  const { orderId, token } = req.query as { orderId?: string; token?: string };
  if (!orderId) return res.status(400).send("Missing order");
  const order = await prisma.order.findFirst({ where: { razorpayOrderId: orderId }, select: { orderCode: true, costPaise: true } });
  if (!order) return res.status(404).send("Order not found");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    checkoutPage({
      razorpayOrderId: orderId,
      amountPaise: order.costPaise,
      name: "Prinsta",
      description: `Print order ${order.orderCode}`,
      image: `${publicBaseUrl(req)}/logo.png`,
      verifyPath: `${publicBaseUrl(req)}/api/orders/verify`,
      token: token || "",
    })
  );
});

// ── Verify payment & mark the order PAID ────────────────────────────────────
const verifySchema = z.object({
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
});

ordersRouter.post("/verify", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = parsed.data;

  if (!verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    return res.status(400).json({ error: "Payment verification failed" });
  }

  const order = await prisma.order.findFirst({ where: { razorpayOrderId: razorpay_order_id, userId: req.user!.userId } });
  if (!order) return res.status(404).json({ error: "Order not found" });

  if (order.status === "PENDING_PAYMENT") {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "PAID", razorpayPaymentId: razorpay_payment_id } });
      if (order.printerId) await tx.printJob.create({ data: { orderId: order.id, printerId: order.printerId, status: "QUEUED" } });
    });
  }

  res.json({ ok: true, orderId: order.id });
});

// ── List the user's orders ──────────────────────────────────────────────────
ordersRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const orders = await prisma.order.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      document: { select: { fileName: true, fileType: true, pageCount: true } },
      printer: { select: { name: true, shopName: true, brand: true } },
    },
  });
  res.json({ orders });
});

// ── Order detail ────────────────────────────────────────────────────────────
ordersRouter.get("/:id", requireAuth, async (req: AuthedRequest, res) => {
  const order = await prisma.order.findFirst({
    where: { id: req.params.id, userId: req.user!.userId },
    include: {
      document: { select: { id: true, fileName: true, fileType: true, pageCount: true } },
      // Network details so the app can print directly over the printer's Wi-Fi Direct.
      printer: { select: { name: true, shopName: true, brand: true, locationName: true, ipAddress: true, wifiSsid: true, accessPassword: true } },
      printJob: { select: { status: true } },
    },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json({ order });
});

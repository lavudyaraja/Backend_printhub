// User orders: create from an uploaded document, pay by Points or UPI (Razorpay),
// verify payment, list & fetch orders. A PrintJob is queued once an order is PAID.
import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { prisma } from "../lib/prisma";
import { config, publicBaseUrl } from "../lib/config";
import { BLANK_PAGE_PAISE, DEFAULT_BW_PAGE_PAISE, DEFAULT_COLOR_PAGE_PAISE } from "../lib/pricing";
import { requireAuth, type AuthedRequest } from "../middleware/authGuard";
import { maybePayReferralReward } from "../referrals/service";
import { createRazorpayOrder, verifyPaymentSignature, checkoutPage } from "../lib/razorpay";
import { createCheckoutSession, consumeCheckoutSession, peekCheckoutSession } from "../lib/checkoutSession";
import { priceInPoints, pointsToPaise } from "../lib/points";
import { issuePartialRefund } from "../refunds/service";

export const ordersRouter = Router();

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
  // "WALLET" is the pre-rename name for POINTS. Both are accepted because
  // already-installed mobile builds still send the old one, and they must keep
  // working after this deploys.
  paymentMethod: z
    .enum(["POINTS", "WALLET", "UPI", "CREDIT_CARD", "DEBIT_CARD", "NET_BANKING"])
    .default("POINTS"),
  payWithPoints: z.boolean().optional(),
  /** @deprecated old clients send this; prefer `payWithPoints`. */
  payWithWallet: z.boolean().optional(),
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

  // Rates and ownership from the target printer (rates fall back to defaults).
  let bw = DEFAULT_BW_PAGE_PAISE, color = DEFAULT_COLOR_PAGE_PAISE;
  let vendorId: string | null = null;
  let locationId: string | null = null;
  if (d.printerId) {
    const pr = await prisma.printer.findUnique({
      where: { id: d.printerId },
      select: { costPerBWPagePaise: true, costPerColorPagePaise: true, vendorId: true, locationId: true },
    });
    if (pr) {
      bw = pr.costPerBWPagePaise;
      color = pr.costPerColorPagePaise;
      // Recorded on the order itself: the printer may later be reassigned or
      // deleted, but this order's earnings still belong to today's owner.
      vendorId = pr.vendorId;
      locationId = pr.locationId;
    }
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

  // Paying from Prinsta Points earns a discount; paying directly (UPI/card)
  // is charged the full rate. Computed here, on the server — the client's number
  // is only ever a preview.
  const wantsPoints = d.payWithPoints ?? d.payWithWallet ?? true;
  const payingFromPoints =
    wantsPoints || d.paymentMethod === "POINTS" || d.paymentMethod === "WALLET";
  const discountPaise = payingFromPoints
    ? Math.floor((listPaise * config.pointsDiscountPercent) / 100)
    : 0;
  const costPaise = listPaise - discountPaise;

  const baseData = {
    orderCode: "PRT-" + nanoid(6).toUpperCase(),
    userId,
    documentId: doc.id,
    printerId: d.printerId || null,
    vendorId,
    locationId,
    colorMode: (anyColor ? "COLOR" : "BW") as "BW" | "COLOR",
    sideMode: d.sideMode,
    copies: d.copies,
    pageRange: d.pageRange,
    pageColorModes: d.pageColorModes || null,
    pagesToPrint,
    paperSize: d.paperSize,
    costPaise,
    paymentMethod: d.paymentMethod === "WALLET" ? "POINTS" : d.paymentMethod,
    printToken: nanoid(16),
  };

  // ── Points payment ──
  if (payingFromPoints) {
    // The order is priced in money; the balance is held in points. Convert once,
    // here, and charge exactly that.
    const costPoints = priceInPoints(costPaise);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { pointsBalance: true } });
    if (!user || user.pointsBalance < costPoints) {
      return res.status(402).json({
        error: "INSUFFICIENT_FUNDS",
        requiredPoints: costPoints,
        balancePoints: user?.pointsBalance || 0,
        requiredPaise: costPaise,
        balancePaise: pointsToPaise(user?.pointsBalance || 0),
      });
    }

    const order = await prisma.$transaction(async (tx) => {
      const o = await tx.order.create({ data: { ...baseData, paymentMethod: "POINTS", status: "PAID" } });
      const u = await tx.user.update({ where: { id: userId }, data: { pointsBalance: { decrement: costPoints } } });
      await tx.pointsTransaction.create({
        data: {
          userId,
          type: "DEBIT",
          amountPoints: costPoints,
          balancePoints: u.pointsBalance,
          description: `Print order ${o.orderCode}`,
          orderId: o.id,
        },
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

  // The full amount is collected into the platform account — no split. The
  // shop's share (cost less commission) accrues against its completed orders
  // and is settled later through the payout system, so a direct payment doesn't
  // need the vendor to be onboarded to any gateway to be accepted.
  const rz = await createRazorpayOrder(costPaise, order.orderCode, { orderId: order.id });
  const updated = await prisma.order.update({ where: { id: order.id }, data: { razorpayOrderId: rz.id } });

  res.json({ order: updated, razorpayOrderId: rz.id, keyId: config.razorpay.keyId, mode: config.razorpay.mode, amountPaise: costPaise });
});

// ── Dispense blank pages ────────────────────────────────────────────────────
// Plain sheets, no document to print. Priced per sheet at a flat rate rather
// than at the printer's BW/colour rates — nothing is being imaged, so the cost
// is the paper, not the toner.

const blankSchema = z.object({
  pagesCount: z.number().int().min(1).max(100),
  copies: z.number().int().min(1).max(10).default(1),
  printerId: z.string().optional(),
  paymentMethod: z.enum(["POINTS", "WALLET", "UPI"]).default("POINTS"),
  payWithPoints: z.boolean().optional(),
});

ordersRouter.post("/blank", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = blankSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
  const d = parsed.data;
  const userId = req.user!.userId;

  const sheets = d.pagesCount * d.copies;
  const listPaise = sheets * BLANK_PAGE_PAISE;

  const wantsPoints = d.payWithPoints ?? true;
  const payingFromPoints = wantsPoints || d.paymentMethod === "POINTS" || d.paymentMethod === "WALLET";
  // Same rule as a document order: paying from points skips the gateway fee, so
  // the saving is passed back.
  const discountPaise = payingFromPoints ? Math.floor((listPaise * config.pointsDiscountPercent) / 100) : 0;
  const costPaise = listPaise - discountPaise;

  // Carry the owner from the printer so the sheets are billed to whoever's tray
  // they come out of.
  let vendorId: string | null = null;
  let locationId: string | null = null;
  if (d.printerId) {
    const pr = await prisma.printer.findUnique({
      where: { id: d.printerId },
      select: { vendorId: true, locationId: true },
    });
    if (pr) { vendorId = pr.vendorId; locationId = pr.locationId; }
  }

  // Order.documentId is required and unique, so a blank job still needs a
  // Document row. It carries no bytes — only the label and the sheet count —
  // which is enough for the order history to render, and leaves the cleanup
  // sweeper nothing to strip (it only clears rows that still hold fileData).
  const doc = await prisma.document.create({
    data: {
      userId,
      fileName: `Blank pages (${d.pagesCount} sheet${d.pagesCount > 1 ? "s" : ""})`,
      fileType: "blank",
      fileKey: `blank/${userId}`,
      mimeType: null,
      fileData: null,
      sizeBytes: 0,
      pageCount: d.pagesCount,
    },
    select: { id: true },
  });

  const baseData = {
    orderCode: "BLK-" + nanoid(6).toUpperCase(),
    userId,
    documentId: doc.id,
    printerId: d.printerId || null,
    vendorId,
    locationId,
    colorMode: "BW" as const,
    sideMode: "SINGLE" as const,
    copies: d.copies,
    pageRange: "all",
    pagesToPrint: d.pagesCount,
    paperSize: "A4",
    costPaise,
    printToken: nanoid(16),
  };

  // ── Points payment ──
  if (payingFromPoints) {
    const costPoints = priceInPoints(costPaise);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { pointsBalance: true } });
    if (!user || user.pointsBalance < costPoints) {
      // The placeholder document would otherwise be left behind with no order,
      // and it holds no bytes for the orphan sweeper to find worth removing.
      await prisma.document.delete({ where: { id: doc.id } }).catch(() => {});
      return res.status(402).json({
        error: "INSUFFICIENT_FUNDS",
        requiredPoints: costPoints,
        balancePoints: user?.pointsBalance || 0,
        requiredPaise: costPaise,
        balancePaise: pointsToPaise(user?.pointsBalance || 0),
      });
    }

    const order = await prisma.$transaction(async (tx) => {
      const o = await tx.order.create({ data: { ...baseData, paymentMethod: "POINTS", status: "PAID" } });
      const u = await tx.user.update({ where: { id: userId }, data: { pointsBalance: { decrement: costPoints } } });
      await tx.pointsTransaction.create({
        data: {
          userId,
          type: "DEBIT",
          amountPoints: costPoints,
          balancePoints: u.pointsBalance,
          description: `Blank pages ${o.orderCode}`,
          orderId: o.id,
        },
      });
      if (o.printerId) await tx.printJob.create({ data: { orderId: o.id, printerId: o.printerId, status: "QUEUED" } });
      return o;
    });

    return res.json({ order });
  }

  // ── Direct payment (UPI) → create a Razorpay order ──
  if (!config.razorpay.configured) {
    await prisma.document.delete({ where: { id: doc.id } }).catch(() => {});
    return res.status(503).json({ error: "Online payments are not enabled on the server yet." });
  }
  const order = await prisma.order.create({ data: { ...baseData, paymentMethod: "UPI", status: "PENDING_PAYMENT" } });

  // Collected in full to the platform account; the shop's share is settled later
  // through payouts (see the document-order path above).
  const rz = await createRazorpayOrder(costPaise, order.orderCode, { orderId: order.id });
  const updated = await prisma.order.update({ where: { id: order.id }, data: { razorpayOrderId: rz.id } });

  res.json({ order: updated, razorpayOrderId: rz.id, keyId: config.razorpay.keyId, mode: config.razorpay.mode, amountPaise: costPaise });
});

// ── Open a checkout session ─────────────────────────────────────────────────
// Exchanges the caller's auth for a single-use session id, so the checkout URL
// the WebView loads carries no long-lived credential.
ordersRouter.post("/checkout-session", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = z.object({ razorpayOrderId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Missing Razorpay order id." });

  const order = await prisma.order.findFirst({
    where: { razorpayOrderId: parsed.data.razorpayOrderId, userId: req.user!.userId },
    select: { id: true },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });

  const sessionId = createCheckoutSession(req.user!.userId, parsed.data.razorpayOrderId);
  res.json({ checkoutUrl: `${publicBaseUrl(req)}/api/orders/checkout?session=${encodeURIComponent(sessionId)}` });
});

// ── Hosted checkout page (opened in the app's WebView) ──────────────────────
// Rendering only peeks at the session — it is spent at /verify, so a reload of
// the page mid-payment doesn't strand the user.
ordersRouter.get("/checkout", async (req, res) => {
  const session = peekCheckoutSession(req.query.session);
  if (!session) return res.status(403).send("This payment link has expired. Please start the order again.");

  const order = await prisma.order.findFirst({
    where: { razorpayOrderId: session.razorpayOrderId },
    select: { orderCode: true, costPaise: true },
  });
  if (!order) return res.status(404).send("Order not found");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    checkoutPage({
      razorpayOrderId: session.razorpayOrderId,
      amountPaise: order.costPaise,
      name: "Prinsta",
      description: `Print order ${order.orderCode}`,
      image: `${publicBaseUrl(req)}/logo.png`,
      verifyPath: `${publicBaseUrl(req)}/api/orders/verify`,
      sessionId: String(req.query.session),
    })
  );
});

// ── Verify payment & mark the order PAID ────────────────────────────────────
const verifySchema = z.object({
  sessionId: z.string().min(1),
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
});

// Called by the hosted checkout page, which identifies itself with the session
// id rather than a bearer token — see lib/checkoutSession.ts.
ordersRouter.post("/verify", async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });
  const { sessionId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = parsed.data;

  const session = peekCheckoutSession(sessionId);
  if (!session) return res.status(403).json({ error: "This payment session has expired." });
  // The session authorises exactly one Razorpay order; without this check a
  // session opened for one order could be used to mark a different one paid.
  if (session.razorpayOrderId !== razorpay_order_id) {
    return res.status(403).json({ error: "This payment session does not match the order." });
  }

  if (!verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    return res.status(400).json({ error: "Payment verification failed" });
  }

  const order = await prisma.order.findFirst({ where: { razorpayOrderId: razorpay_order_id, userId: session.userId } });
  if (!order) return res.status(404).json({ error: "Order not found" });

  if (order.status === "PENDING_PAYMENT") {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "PAID", razorpayPaymentId: razorpay_payment_id } });
      if (order.printerId) await tx.printJob.create({ data: { orderId: order.id, printerId: order.printerId, status: "QUEUED" } });
    });
  }

  // Spend the session only once the order is actually marked paid.
  consumeCheckoutSession(sessionId);
  res.json({ ok: true, orderId: order.id });
});

// ── Simulate a successful payment (TEST MODE ONLY) ──────────────────────────
// Real UPI apps (GPay/PhonePe) cannot complete a Razorpay *test* payment, so
// there is no way to exercise the "paid → printout" flow end-to-end with test
// keys. This marks a pending order PAID directly. It is hard-gated to test mode:
// the moment live keys (rzp_live_…) are set, this route refuses and the app
// falls back to the real Razorpay checkout.
ordersRouter.post("/:id/simulate-pay", requireAuth, async (req: AuthedRequest, res) => {
  if (config.razorpay.mode !== "test") {
    return res.status(403).json({ error: "Simulated payments are disabled in live mode." });
  }
  const order = await prisma.order.findFirst({ where: { id: req.params.id, userId: req.user!.userId } });
  if (!order) return res.status(404).json({ error: "Order not found" });

  if (order.status === "PENDING_PAYMENT") {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "PAID", razorpayPaymentId: "test_" + nanoid(12) } });
      if (order.printerId) await tx.printJob.create({ data: { orderId: order.id, printerId: order.printerId, status: "QUEUED" } });
    });
  }

  res.json({ ok: true, orderId: order.id, test: true });
});

// ── Advance an order's print status (owner) ─────────────────────────────────
// The app calls this as the user prints: PAID → PRINTING (dialog opened) →
// COMPLETED (print finished). Only ever moves forward from a paid/printing state.
//
// When a print is interrupted — power cut, jam, the printer stuck part-way — the
// app reports FAILED with `printedPages`, the count that actually came out. The
// server splits the money by pages: the unprinted share is refunded to the
// customer as Points, and the shop earns (and settles) only the printed share.
ordersRouter.post("/:id/status", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = z
    .object({
      status: z.enum(["PRINTING", "COMPLETED", "PAID", "FAILED"]),
      /** Pages actually printed, on a FAILED (interrupted) report. */
      printedPages: z.coerce.number().int().min(0).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid status" });

  const order = await prisma.order.findFirst({ where: { id: req.params.id, userId: req.user!.userId } });
  if (!order) return res.status(404).json({ error: "Order not found" });

  // Never move backwards or touch a failed/cancelled order.
  if (!["PAID", "READY", "PRINTING"].includes(order.status)) {
    return res.json({ ok: true, status: order.status });
  }

  // Interrupted print: settle the money by pages before recording the status.
  if (parsed.data.status === "FAILED") {
    const printed = parsed.data.printedPages ?? 0;
    const result = await issuePartialRefund(order.id, printed);
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    // Some pages came out → the order is partially fulfilled and the shop earns
    // its share, so it counts as COMPLETED. Nothing came out → a clean FAILED
    // with the whole cost refunded.
    const finalStatus = result.kind === "full" ? "FAILED" : "COMPLETED";
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { status: finalStatus },
    });
    if (finalStatus === "COMPLETED") await maybePayReferralReward(order.userId);
    return res.json({
      ok: true,
      status: updated.status,
      refundPointsCredited: result.pointsCredited,
      settlementPaise: result.settlementPaise,
    });
  }

  const updated = await prisma.order.update({ where: { id: order.id }, data: { status: parsed.data.status } });

  // A first completed print is what earns a referral, for both sides. Awaited
  // so the balance has moved by the time the app refetches it, but it swallows
  // its own errors — a reward that failed must not fail the status update that
  // told the user their print is done.
  if (updated.status === "COMPLETED") {
    await maybePayReferralReward(order.userId);
  }

  res.json({ ok: true, status: updated.status });
});

// ── Link an order to the printer it's actually being printed on ──────────────
// Orders started without picking a printer from the list have no printerId, so
// they never reach the shop that owns the machine. When the app connects to a
// printer's Wi-Fi Direct network to print, it tells us the SSID here; we resolve
// that to the registered printer and stamp the order with its printer + vendor,
// so the order (and any issue raised on it) reaches the right shop.
ordersRouter.post("/:id/attach-printer", requireAuth, async (req: AuthedRequest, res) => {
  const uniquePrinterId = typeof req.body?.uniquePrinterId === "string" ? req.body.uniquePrinterId.trim() : "";
  const ssid = typeof req.body?.ssid === "string" ? req.body.ssid.trim() : "";
  if (!uniquePrinterId && !ssid) return res.status(400).json({ error: "Missing printer id." });

  const order = await prisma.order.findFirst({
    where: { id: req.params.id, userId: req.user!.userId },
    select: { id: true, printerId: true, vendorId: true },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });

  // Already linked to a shop — nothing to do.
  if (order.printerId && order.vendorId) return res.json({ ok: true, alreadyLinked: true });

  // Resolve by the unique printer id first — it identifies the exact machine, so
  // identical printers at different shops can't be confused. The SSID is only a
  // last-resort fallback for a legacy QR that carried no id.
  const printer = uniquePrinterId
    ? await prisma.printer.findUnique({
        where: { uniquePrinterId: uniquePrinterId.toUpperCase() },
        select: { id: true, vendorId: true, locationId: true },
      })
    : await prisma.printer.findFirst({
        where: { wifiSsid: { equals: ssid, mode: "insensitive" } },
        select: { id: true, vendorId: true, locationId: true },
      });
  if (!printer) return res.json({ ok: false, reason: "NO_MATCH" });

  await prisma.order.update({
    where: { id: order.id },
    data: { printerId: printer.id, vendorId: printer.vendorId, locationId: printer.locationId },
  });
  await prisma.printJob
    .updateMany({ where: { orderId: order.id }, data: { printerId: printer.id } })
    .catch(() => {});

  res.json({ ok: true, linked: true });
});

// ── List the user's orders ──────────────────────────────────────────────────
ordersRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const orders = await prisma.order.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      // keepUntil/deleted let the app tell a reorder that can skip upload from
      // one that can't: a file the user didn't keep is gone within the hour.
      document: {
        select: { id: true, fileName: true, fileType: true, pageCount: true, keepUntil: true, deleted: true },
      },
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

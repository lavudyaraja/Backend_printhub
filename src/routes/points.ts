// Prinsta Points: balance, transaction history, and Razorpay top-up (UPI).
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { config, publicBaseUrl } from "../lib/config";
import { requireAuth, type AuthedRequest } from "../middleware/authGuard";
import { createRazorpayOrder, fetchRazorpayOrder, verifyPaymentSignature, checkoutPage } from "../lib/razorpay";
import { createCheckoutSession, consumeCheckoutSession, peekCheckoutSession } from "../lib/checkoutSession";
import { topupBreakdown, pointsToPaise } from "../lib/points";

export const pointsRouter = Router();

const MIN_TOPUP_PAISE = 1000; // ₹10

/**
 * Credit a completed top-up: the points the money bought, plus the tier bonus.
 *
 * The bonus is written as its own transaction rather than folded into the base
 * amount, so the history shows the user what they earned instead of just a
 * number larger than what they paid for.
 */
async function creditTopup(opts: {
  userId: string;
  amountPaise: number;
  razorpayId: string;
  /** Appended to the descriptions, e.g. " (test)". */
  suffix?: string;
}): Promise<number> {
  const { basePoints, bonusPoints, bonusPercent } = topupBreakdown(opts.amountPaise);
  const suffix = opts.suffix || "";

  return prisma.$transaction(async (tx) => {
    const afterBase = await tx.user.update({
      where: { id: opts.userId },
      data: { pointsBalance: { increment: basePoints } },
    });
    await tx.pointsTransaction.create({
      data: {
        userId: opts.userId,
        type: "CREDIT",
        amountPoints: basePoints,
        balancePoints: afterBase.pointsBalance,
        description: `Points top-up${suffix}`,
        razorpayId: opts.razorpayId,
      },
    });

    if (bonusPoints <= 0) return afterBase.pointsBalance;

    const afterBonus = await tx.user.update({
      where: { id: opts.userId },
      data: { pointsBalance: { increment: bonusPoints } },
    });
    await tx.pointsTransaction.create({
      data: {
        userId: opts.userId,
        type: "CREDIT",
        amountPoints: bonusPoints,
        balancePoints: afterBonus.pointsBalance,
        description: `Bonus ${bonusPercent}% on top-up${suffix}`,
        razorpayId: `${opts.razorpayId}_bonus`,
      },
    });
    return afterBonus.pointsBalance;
  });
}

// ── Balance + recent transactions ───────────────────────────────────────────
pointsRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const [user, transactions] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.user!.userId }, select: { pointsBalance: true } }),
    prisma.pointsTransaction.findMany({ where: { userId: req.user!.userId }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const balancePoints = user?.pointsBalance || 0;
  res.json({
    balancePoints,
    /** Rupee equivalent, so the app never has to divide by the rate itself. */
    balancePaise: pointsToPaise(balancePoints),
    transactions,
  });
});

// ── Start a top-up → create a Razorpay order ────────────────────────────────
pointsRouter.post("/topup", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = z.object({ amountPaise: z.number().int().min(MIN_TOPUP_PAISE) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: `Minimum top-up is ₹${MIN_TOPUP_PAISE / 100}.` });
  if (!config.razorpay.configured) return res.status(503).json({ error: "Online payments are not enabled on the server yet." });

  const rz = await createRazorpayOrder(parsed.data.amountPaise, `points_${req.user!.userId.slice(-8)}`, {
    kind: "points_topup",
    userId: req.user!.userId,
  });
  res.json({ razorpayOrderId: rz.id, keyId: config.razorpay.keyId, mode: config.razorpay.mode, amountPaise: parsed.data.amountPaise });
});

// ── Simulate a successful top-up (TEST MODE ONLY) ───────────────────────────
// Real UPI apps can't complete a Razorpay *test* payment, so this credits the
// Points balance directly for testing. Hard-gated to test mode — refuses the moment live
// keys are set, so the app falls back to the real hosted checkout.
pointsRouter.post("/simulate-topup", requireAuth, async (req: AuthedRequest, res) => {
  if (config.razorpay.mode !== "test") {
    return res.status(403).json({ error: "Simulated payments are disabled in live mode." });
  }
  const parsed = z.object({ amountPaise: z.number().int().min(MIN_TOPUP_PAISE) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: `Minimum top-up is ₹${MIN_TOPUP_PAISE / 100}.` });

  const balancePoints = await creditTopup({
    userId: req.user!.userId,
    amountPaise: parsed.data.amountPaise,
    razorpayId: "test_" + Date.now(),
    suffix: " (test)",
  });
  res.json({
    ok: true,
    balancePoints,
    balancePaise: pointsToPaise(balancePoints),
    credited: topupBreakdown(parsed.data.amountPaise),
    test: true,
  });
});

// ── Open a checkout session ─────────────────────────────────────────────────
// Exchanges the caller's auth for a single-use session id, so the checkout URL
// the WebView loads carries no long-lived credential.
pointsRouter.post("/checkout-session", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = z.object({ razorpayOrderId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Missing Razorpay order id." });

  const rz = await fetchRazorpayOrder(parsed.data.razorpayOrderId).catch(() => null);
  if (!rz) return res.status(404).json({ error: "Order not found" });

  const sessionId = createCheckoutSession(req.user!.userId, parsed.data.razorpayOrderId);
  res.json({ checkoutUrl: `${publicBaseUrl(req)}/api/points/checkout?session=${encodeURIComponent(sessionId)}` });
});

// ── Hosted checkout page (WebView) ──────────────────────────────────────────
// Rendering only peeks at the session — it is spent at /verify, so a reload of
// the page mid-payment doesn't strand the user.
pointsRouter.get("/checkout", async (req, res) => {
  const session = peekCheckoutSession(req.query.session);
  if (!session) return res.status(403).send("This payment link has expired. Please start the top-up again.");

  const rz = await fetchRazorpayOrder(session.razorpayOrderId).catch(() => null);
  if (!rz) return res.status(404).send("Order not found");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    checkoutPage({
      razorpayOrderId: session.razorpayOrderId,
      amountPaise: rz.amount,
      name: "Prinsta Points",
      description: `Points top-up ₹${(rz.amount / 100).toFixed(2)}`,
      verifyPath: `${publicBaseUrl(req)}/api/points/verify`,
      sessionId: String(req.query.session),
    })
  );
});

// ── Verify payment → credit the Points balance ──────────────────────────────
const verifySchema = z.object({
  sessionId: z.string().min(1),
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
});

// Called by the hosted checkout page, which identifies itself with the session
// id rather than a bearer token — see lib/checkoutSession.ts.
pointsRouter.post("/verify", async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });
  const { sessionId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = parsed.data;

  const session = peekCheckoutSession(sessionId);
  if (!session) return res.status(403).json({ error: "This payment session has expired." });
  // The session authorises exactly one Razorpay order; without this check a
  // session opened for one top-up could be used to credit a different payment.
  if (session.razorpayOrderId !== razorpay_order_id) {
    return res.status(403).json({ error: "This payment session does not match the order." });
  }
  const userId = session.userId;

  if (!verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    return res.status(400).json({ error: "Payment verification failed" });
  }

  // Idempotency — don't double-credit the same payment.
  const existing = await prisma.pointsTransaction.findFirst({ where: { razorpayId: razorpay_payment_id } });
  if (existing) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { pointsBalance: true } });
    const balancePoints = u?.pointsBalance || 0;
    return res.json({ ok: true, balancePoints, balancePaise: pointsToPaise(balancePoints) });
  }

  // Authoritative amount from Razorpay (never trust the client).
  const rz = await fetchRazorpayOrder(razorpay_order_id);

  const balancePoints = await creditTopup({
    userId,
    amountPaise: rz.amount,
    razorpayId: razorpay_payment_id,
  });

  // Spend the session only once the credit has actually landed, so a network
  // hiccup on the way back doesn't leave the user unable to retry.
  consumeCheckoutSession(sessionId);
  res.json({
    ok: true,
    balancePoints,
    balancePaise: pointsToPaise(balancePoints),
    credited: topupBreakdown(rz.amount),
  });
});

// Prinsta Wallet: balance, transaction history, and Razorpay top-up (UPI).
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { config, publicBaseUrl } from "../lib/config";
import { requireAuth, type AuthedRequest } from "../middleware/authGuard";
import { createRazorpayOrder, fetchRazorpayOrder, verifyPaymentSignature, checkoutPage } from "../lib/razorpay";

export const walletRouter = Router();

const MIN_TOPUP_PAISE = 1000; // ₹10

// ── Balance + recent transactions ───────────────────────────────────────────
walletRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const [user, transactions] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.user!.userId }, select: { walletBalancePaise: true } }),
    prisma.walletTransaction.findMany({ where: { userId: req.user!.userId }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  res.json({ balancePaise: user?.walletBalancePaise || 0, transactions });
});

// ── Start a top-up → create a Razorpay order ────────────────────────────────
walletRouter.post("/topup", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = z.object({ amountPaise: z.number().int().min(MIN_TOPUP_PAISE) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: `Minimum top-up is ₹${MIN_TOPUP_PAISE / 100}.` });
  if (!config.razorpay.configured) return res.status(503).json({ error: "Online payments are not enabled on the server yet." });

  const rz = await createRazorpayOrder(parsed.data.amountPaise, `wallet_${req.user!.userId.slice(-8)}`, {
    kind: "wallet_topup",
    userId: req.user!.userId,
  });
  res.json({ razorpayOrderId: rz.id, keyId: config.razorpay.keyId, mode: config.razorpay.mode, amountPaise: parsed.data.amountPaise });
});

// ── Hosted checkout page (WebView) ──────────────────────────────────────────
walletRouter.get("/checkout", async (req, res) => {
  const { orderId, token } = req.query as { orderId?: string; token?: string };
  if (!orderId) return res.status(400).send("Missing order");
  const rz = await fetchRazorpayOrder(orderId).catch(() => null);
  if (!rz) return res.status(404).send("Order not found");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    checkoutPage({
      razorpayOrderId: orderId,
      amountPaise: rz.amount,
      name: "Prinsta Wallet",
      description: `Wallet top-up ₹${(rz.amount / 100).toFixed(2)}`,
      verifyPath: `${publicBaseUrl(req)}/api/wallet/verify`,
      token: token || "",
    })
  );
});

// ── Verify payment → credit the wallet ──────────────────────────────────────
const verifySchema = z.object({
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
});

walletRouter.post("/verify", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = parsed.data;
  const userId = req.user!.userId;

  if (!verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    return res.status(400).json({ error: "Payment verification failed" });
  }

  // Idempotency — don't double-credit the same payment.
  const existing = await prisma.walletTransaction.findFirst({ where: { razorpayId: razorpay_payment_id } });
  if (existing) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { walletBalancePaise: true } });
    return res.json({ ok: true, balancePaise: u?.walletBalancePaise || 0 });
  }

  // Authoritative amount from Razorpay (never trust the client).
  const rz = await fetchRazorpayOrder(razorpay_order_id);

  const u = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({ where: { id: userId }, data: { walletBalancePaise: { increment: rz.amount } } });
    await tx.walletTransaction.create({
      data: { userId, type: "CREDIT", amountPaise: rz.amount, balancePaise: updated.walletBalancePaise, description: "Wallet top-up", razorpayId: razorpay_payment_id },
    });
    return updated;
  });

  res.json({ ok: true, balancePaise: u.walletBalancePaise });
});

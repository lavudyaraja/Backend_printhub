// Wallet — prepaid balance for faster print payments.
// Endpoints:
//   GET  /api/wallet          -> balance + recent transactions
//   POST /api/wallet/topup    -> add money (see PAYMENT note below)
//
// PAYMENT NOTE: a real top-up must be backed by a payment gateway (Razorpay).
// That integration is intentionally left commented — the endpoint currently
// credits the wallet directly so the feature is usable end-to-end now. Wire the
// gateway (create order → verify signature) before charging real money.
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthedRequest } from "../middleware/authGuard";

export const walletRouter = Router();

const MIN_TOPUP = 1000; // ₹10
const MAX_TOPUP = 10_00_000; // ₹1,00,000

// Get balance + recent transactions.
walletRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const [user, txns] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.user!.userId }, select: { walletBalancePaise: true } }),
    prisma.walletTransaction.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  res.json({ balancePaise: user?.walletBalancePaise ?? 0, transactions: txns });
});

// Top up the wallet.
const topupSchema = z.object({ amountPaise: z.number().int().min(MIN_TOPUP).max(MAX_TOPUP) });

walletRouter.post("/topup", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = topupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: `Enter an amount between ₹${MIN_TOPUP / 100} and ₹${MAX_TOPUP / 100}` });
  }
  const { amountPaise } = parsed.data;

  // ── Real payment (Razorpay) — enable before charging real money ──────
  // const order = await razorpay.orders.create({ amount: amountPaise, currency: "INR" });
  // return res.json({ razorpayOrderId: order.id, amountPaise });   // then verify on /topup/verify
  // ---------------------------------------------------------------------

  const result = await creditWallet(req.user!.userId, amountPaise, "Wallet top-up");
  res.json({ balancePaise: result.balancePaise, transaction: result.txn });
});

// ── Shared helpers (also used by the order flow) ─────────────────────

// Add money to a wallet atomically and record a CREDIT transaction.
export async function creditWallet(userId: string, amountPaise: number, description: string, orderId?: string) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data: { walletBalancePaise: { increment: amountPaise } },
      select: { walletBalancePaise: true },
    });
    const txn = await tx.walletTransaction.create({
      data: {
        userId,
        type: "CREDIT",
        amountPaise,
        balancePaise: user.walletBalancePaise,
        description,
        orderId: orderId || null,
      },
    });
    return { balancePaise: user.walletBalancePaise, txn };
  });
}

// Spend from a wallet atomically. Throws "INSUFFICIENT_FUNDS" if the balance is
// too low, so callers can prompt the user to top up.
export async function debitWallet(userId: string, amountPaise: number, description: string, orderId?: string) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { walletBalancePaise: true } });
    if (!user || user.walletBalancePaise < amountPaise) {
      throw new Error("INSUFFICIENT_FUNDS");
    }
    const updated = await tx.user.update({
      where: { id: userId },
      data: { walletBalancePaise: { decrement: amountPaise } },
      select: { walletBalancePaise: true },
    });
    const txn = await tx.walletTransaction.create({
      data: {
        userId,
        type: "DEBIT",
        amountPaise,
        balancePaise: updated.walletBalancePaise,
        description,
        orderId: orderId || null,
      },
    });
    return { balancePaise: updated.walletBalancePaise, txn };
  });
}

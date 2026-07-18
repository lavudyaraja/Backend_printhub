// Prinsta Admin API: stats, revenue, orders, users, support tickets, settings
import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/authGuard";
import { readSettings, writeSettings, maskSecrets } from "../lib/settings";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("ADMIN"));

const LOW_PAPER = 20;

// ── Dashboard metrics ──────────────────────────────────────────────────────────
adminRouter.get("/metrics", async (_req, res) => {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

  const [
    totalOrders, completedOrders, failedOrders, cancelledOrders,
    dailyOrders, monthlyOrders, lastMonthOrders,
    totalUsers, newUsersToday,
    revenueAll, revenueMonth, revenueLastMonth,
    pagesAll, printers,
    walletStats,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.order.count({ where: { status: "COMPLETED" } }),
    prisma.order.count({ where: { status: "FAILED" } }),
    prisma.order.count({ where: { status: "CANCELLED" } }),
    prisma.order.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.order.count({ where: { createdAt: { gte: startOfMonth } } }),
    prisma.order.count({ where: { createdAt: { gte: startOfLastMonth, lte: endOfLastMonth } } }),
    prisma.user.count({ where: { role: "STUDENT" } }),
    prisma.user.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.order.aggregate({ _sum: { costPaise: true }, where: { status: "COMPLETED" } }),
    prisma.order.aggregate({ _sum: { costPaise: true }, where: { status: "COMPLETED", createdAt: { gte: startOfMonth } } }),
    prisma.order.aggregate({ _sum: { costPaise: true }, where: { status: "COMPLETED", createdAt: { gte: startOfLastMonth, lte: endOfLastMonth } } }),
    prisma.order.aggregate({ _sum: { pagesToPrint: true }, where: { status: "COMPLETED" } }),
    prisma.printer.findMany({ select: { id: true, status: true, paperLevel: true, tonerLevel: true } }),
    prisma.walletTransaction.aggregate({ _sum: { amountPaise: true }, where: { type: "CREDIT" } }),
  ]);

  const thisMonthRevenue = revenueMonth._sum.costPaise || 0;
  const lastMonthRevenue = revenueLastMonth._sum.costPaise || 0;
  const revenueGrowth = lastMonthRevenue === 0 ? 100 : Math.round(((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100);

  const orderGrowth = lastMonthOrders === 0 ? 100 : Math.round(((monthlyOrders - lastMonthOrders) / lastMonthOrders) * 100);

  res.json({
    totalOrders,
    completedOrders,
    failedOrders,
    cancelledOrders,
    dailyOrders,
    monthlyOrders,
    orderGrowth,
    totalUsers,
    newUsersToday,
    totalRevenuePaise: revenueAll._sum.costPaise || 0,
    monthlyRevenuePaise: thisMonthRevenue,
    revenueGrowth,
    totalPagesPrinted: pagesAll._sum.pagesToPrint || 0,
    totalPrinters: printers.length,
    activePrinters: printers.filter((p) => p.status === "ONLINE").length,
    offlinePrinters: printers.filter((p) => p.status === "OFFLINE").length,
    lowPaperCount: printers.filter((p) => p.paperLevel <= LOW_PAPER).length,
    walletTopupPaise: walletStats._sum.amountPaise || 0,
  });
});

// ── Revenue analytics (last 30 days by day) ───────────────────────────────────
adminRouter.get("/revenue", async (req, res) => {
  const { period = "30d" } = req.query as { period?: string };
  const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;

  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  // Get completed orders grouped by day
  const orders = await prisma.order.findMany({
    where: { status: "COMPLETED", createdAt: { gte: since } },
    select: { createdAt: true, costPaise: true, pagesToPrint: true, colorMode: true },
    orderBy: { createdAt: "asc" },
  });

  // Group by date
  const dayMap = new Map<string, { date: string; revenuePaise: number; orders: number; pages: number; bwOrders: number; colorOrders: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().split("T")[0];
    dayMap.set(key, { date: key, revenuePaise: 0, orders: 0, pages: 0, bwOrders: 0, colorOrders: 0 });
  }

  for (const o of orders) {
    const key = o.createdAt.toISOString().split("T")[0];
    const entry = dayMap.get(key);
    if (entry) {
      entry.revenuePaise += o.costPaise;
      entry.orders += 1;
      entry.pages += o.pagesToPrint;
      if (o.colorMode === "COLOR") entry.colorOrders += 1;
      else entry.bwOrders += 1;
    }
  }

  // Top printers by revenue
  const topPrinters = await prisma.order.groupBy({
    by: ["printerId"],
    where: { status: "COMPLETED", createdAt: { gte: since }, printerId: { not: null } },
    _sum: { costPaise: true },
    _count: { id: true },
    orderBy: { _sum: { costPaise: "desc" } },
    take: 5,
  });

  const printerIds = topPrinters.map((p) => p.printerId).filter(Boolean) as string[];
  const printerNames = await prisma.printer.findMany({
    where: { id: { in: printerIds } },
    select: { id: true, name: true, shopName: true },
  });
  const nameMap = Object.fromEntries(printerNames.map((p) => [p.id, `${p.name} (${p.shopName})`]));

  res.json({
    chartData: Array.from(dayMap.values()),
    topPrinters: topPrinters.map((p) => ({
      printerId: p.printerId,
      name: p.printerId ? nameMap[p.printerId] || "Unknown" : "Unassigned",
      revenuePaise: p._sum.costPaise || 0,
      orders: p._count.id,
    })),
  });
});

// ── Orders list ────────────────────────────────────────────────────────────────
adminRouter.get("/orders", async (req, res) => {
  const { status, search, limit = "50", offset = "0" } = req.query as Record<string, string>;

  const where: any = {};
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { orderCode: { contains: search, mode: "insensitive" } },
      { user: { name: { contains: search, mode: "insensitive" } } },
      { user: { phone: { contains: search } } },
    ];
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
      include: {
        user: { select: { name: true, phone: true, email: true } },
        document: { select: { fileName: true, pageCount: true } },
        printer: { select: { name: true, shopName: true, uniquePrinterId: true } },
      },
    }),
    prisma.order.count({ where }),
  ]);

  res.json({ orders, total });
});

// ── Users list ─────────────────────────────────────────────────────────────────
adminRouter.get("/users", async (req, res) => {
  const { search, role, limit = "50", offset = "0" } = req.query as Record<string, string>;

  const where: any = {};
  if (role) where.role = role;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { phone: { contains: search } },
      { email: { contains: search, mode: "insensitive" } },
    ];
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
      select: {
        id: true, name: true, phone: true, email: true,
        role: true, walletBalancePaise: true, createdAt: true,
        _count: { select: { orders: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  res.json({ users, total });
});

// ── Wallet / transactions ──────────────────────────────────────────────────────
adminRouter.get("/transactions", async (req, res) => {
  const { type, search, limit = "50", offset = "0" } = req.query as Record<string, string>;

  const where: any = {};
  if (type) where.type = type;
  if (search) {
    where.OR = [
      { user: { name: { contains: search, mode: "insensitive" } } },
      { description: { contains: search, mode: "insensitive" } },
    ];
  }

  const [txns, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
      include: { user: { select: { name: true, phone: true } } },
    }),
    prisma.walletTransaction.count({ where }),
  ]);

  res.json({ transactions: txns, total });
});

// ── Printers with low-resource alerts ─────────────────────────────────────────
adminRouter.get("/kiosks", async (_req, res) => {
  const printers = await prisma.printer.findMany({ orderBy: { shopName: "asc" } });
  res.json({
    kiosks: printers.map((p) => ({
      ...p,
      needsPaper: p.paperLevel <= LOW_PAPER,
      needsToner: p.tonerLevel <= LOW_PAPER,
    })),
  });
});

adminRouter.patch("/kiosks/:id", async (req, res) => {
  const { paperLevel, tonerLevel, status } = req.body;
  const kiosk = await prisma.printer.update({
    where: { id: req.params.id },
    data: {
      ...(paperLevel !== undefined ? { paperLevel: Math.max(0, Math.min(100, paperLevel)) } : {}),
      ...(tonerLevel !== undefined ? { tonerLevel: Math.max(0, Math.min(100, tonerLevel)) } : {}),
      ...(status ? { status } : {}),
    },
  });
  res.json({ kiosk });
});

// ── Support tickets ────────────────────────────────────────────────────────────
adminRouter.get("/support", async (req, res) => {
  const { status, limit = "50", offset = "0" } = req.query as Record<string, string>;
  const where: any = status ? { status } : {};

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
    }),
    prisma.supportTicket.count({ where }),
  ]);
  res.json({ tickets, total });
});

adminRouter.patch("/support/:id", async (req, res) => {
  const { status, reply } = req.body as { status?: string; reply?: string };
  const ticket = await prisma.supportTicket.update({
    where: { id: req.params.id },
    data: {
      ...(status ? { status } : {}),
      ...(reply !== undefined ? { reply } : {}),
    },
  });
  res.json({ ticket });
});

// ── Platform settings ──────────────────────────────────────────────────────────
adminRouter.get("/settings", async (_req, res) => {
  const settings = await readSettings();
  res.json({ settings: maskSecrets(settings) });
});

adminRouter.put("/settings", async (req, res) => {
  const saved = await writeSettings(req.body?.settings ?? req.body);
  res.json({ settings: maskSecrets(saved) });
});

// ── Change password (Account settings) ──────────────────────────────────────────
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6, "New password must be at least 6 characters"),
});

adminRouter.post("/change-password", async (req: AuthedRequest, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
  }
  const { currentPassword, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!user) return res.status(404).json({ error: "Account not found" });
  if (!user.passwordHash) {
    return res.status(400).json({ error: "This account uses Google sign-in and has no password." });
  }
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Current password is incorrect" });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  res.json({ ok: true });
});

// ── Payout bank account ───────────────────────────────────────────────────────
// One account per admin. Responses never include the full account number — only
// the last four digits, so a leaked response can't be used to move money.

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_NO = /^\d{6,18}$/;

const bankSchema = z.object({
  accountHolder: z.string().trim().min(2, "Enter the account holder's name").max(120),
  accountNumber: z.string().trim().regex(ACCOUNT_NO, "Account number must be 6–18 digits"),
  ifsc: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => IFSC.test(v), "Enter a valid IFSC code (e.g. HDFC0001234)"),
  bankName: z.string().trim().max(120).optional().or(z.literal("")),
  branch: z.string().trim().max(120).optional().or(z.literal("")),
  upiId: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || /^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(v), "Enter a valid UPI ID (e.g. name@bank)"),
});

/** Shape returned to the client — masked, never the full number. */
function publicAccount(a: {
  accountHolder: string; accountNumber: string; ifsc: string;
  bankName: string | null; branch: string | null; upiId: string | null;
  verified: boolean; updatedAt: Date;
}) {
  return {
    accountHolder: a.accountHolder,
    accountLast4: a.accountNumber.slice(-4),
    accountMasked: `••••••${a.accountNumber.slice(-4)}`,
    ifsc: a.ifsc,
    bankName: a.bankName,
    branch: a.branch,
    upiId: a.upiId,
    verified: a.verified,
    updatedAt: a.updatedAt,
  };
}

adminRouter.get("/bank-account", async (req: AuthedRequest, res) => {
  const account = await prisma.bankAccount.findUnique({ where: { userId: req.user!.userId } });
  res.json({ account: account ? publicAccount(account) : null });
});

adminRouter.put("/bank-account", async (req: AuthedRequest, res) => {
  const parsed = bankSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid bank details" });
  }
  const d = parsed.data;
  const data = {
    accountHolder: d.accountHolder,
    accountNumber: d.accountNumber,
    ifsc: d.ifsc,
    bankName: d.bankName || null,
    branch: d.branch || null,
    upiId: d.upiId || null,
    // Any change invalidates a previous verification.
    verified: false,
  };

  const account = await prisma.bankAccount.upsert({
    where: { userId: req.user!.userId },
    create: { userId: req.user!.userId, ...data },
    update: data,
  });
  res.json({ account: publicAccount(account) });
});

adminRouter.delete("/bank-account", async (req: AuthedRequest, res) => {
  await prisma.bankAccount.deleteMany({ where: { userId: req.user!.userId } });
  res.json({ ok: true });
});

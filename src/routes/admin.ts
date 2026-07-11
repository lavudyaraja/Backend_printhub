// Admin dashboard API: metrics, orders, kiosks (paper/toner + low alerts).
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/authGuard";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("ADMIN"));

const LOW_PAPER = 20; // % threshold that flags a kiosk as needing a refill

adminRouter.get("/metrics", async (_req, res) => {
  const startOfDay = new Date(new Date().setHours(0, 0, 0, 0));

  const [totalOrders, completed, failed, users, dailyOrders, revenueAgg, pagesAgg, printers] =
    await Promise.all([
      prisma.order.count(),
      prisma.order.count({ where: { status: "COMPLETED" } }),
      prisma.order.count({ where: { status: "FAILED" } }),
      prisma.user.count({ where: { role: "STUDENT" } }),
      prisma.order.count({ where: { createdAt: { gte: startOfDay } } }),
      // Revenue = value of completed prints.
      prisma.order.aggregate({ _sum: { costPaise: true }, where: { status: "COMPLETED" } }),
      prisma.order.aggregate({ _sum: { pagesToPrint: true }, where: { status: "COMPLETED" } }),
      prisma.printer.findMany(),
    ]);

  const lowPaperKiosks = printers.filter((p) => p.paperLevel <= LOW_PAPER);

  res.json({
    totalOrders,
    completedPrints: completed,
    failedJobs: failed,
    totalUsers: users,
    dailyOrders,
    totalRevenuePaise: revenueAgg._sum.costPaise || 0,
    totalPagesPrinted: pagesAgg._sum.pagesToPrint || 0,
    totalKiosks: printers.length,
    activeKiosks: printers.filter((p) => p.status === "ONLINE").length,
    lowPaperCount: lowPaperKiosks.length,
  });
});

adminRouter.get("/orders", async (_req, res) => {
  const orders = await prisma.order.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      user: { select: { name: true, phone: true } },
      document: { select: { fileName: true } },
      printer: { select: { name: true } },
    },
  });
  res.json({ orders });
});

// Kiosks with paper/toner levels + low-paper alert flag.
adminRouter.get("/kiosks", async (_req, res) => {
  const printers = await prisma.printer.findMany({ orderBy: { location: "asc" } });
  res.json({
    kiosks: printers.map((p) => ({
      id: p.id,
      name: p.name,
      location: p.location,
      deviceId: p.deviceId,
      status: p.status,
      paperLevel: p.paperLevel,
      tonerLevel: p.tonerLevel,
      lastSeenAt: p.lastSeenAt,
      needsPaper: p.paperLevel <= LOW_PAPER,
      needsToner: p.tonerLevel <= LOW_PAPER,
    })),
  });
});

// Refill / update a kiosk's paper & toner (operator marks it topped up).
adminRouter.patch("/kiosks/:id", async (req, res) => {
  const { paperLevel, tonerLevel, status } = req.body as {
    paperLevel?: number;
    tonerLevel?: number;
    status?: string;
  };
  const kiosk = await prisma.printer.update({
    where: { id: req.params.id },
    data: {
      ...(paperLevel !== undefined ? { paperLevel: Math.max(0, Math.min(100, paperLevel)) } : {}),
      ...(tonerLevel !== undefined ? { tonerLevel: Math.max(0, Math.min(100, tonerLevel)) } : {}),
      ...(status ? { status: status as any } : {}),
    },
  });
  res.json({ kiosk });
});

adminRouter.get("/users", async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, name: true, phone: true, email: true, rollNumber: true, role: true, createdAt: true },
  });
  res.json({ users });
});

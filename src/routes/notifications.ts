import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthedRequest } from "../middleware/authGuard";

export const notificationsRouter = Router();

// ── List the current user's notifications (newest first) ────────────────────
notificationsRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, title: true, body: true, read: true, orderId: true, link: true, createdAt: true },
  });
  res.json({ notifications });
});

// ── Unread badge count ──────────────────────────────────────────────────────
notificationsRouter.get("/unread-count", requireAuth, async (req: AuthedRequest, res) => {
  const count = await prisma.notification.count({
    where: { userId: req.user!.userId, read: false },
  });
  res.json({ count });
});

// ── Mark all as read ────────────────────────────────────────────────────────
notificationsRouter.post("/read-all", requireAuth, async (req: AuthedRequest, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.user!.userId, read: false },
    data: { read: true },
  });
  res.json({ ok: true });
});

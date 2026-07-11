// Notifications: list, unread count, mark-all-read.
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthedRequest } from "../middleware/authGuard";

export const notificationsRouter = Router();

notificationsRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json({ notifications });
});

notificationsRouter.get("/unread-count", requireAuth, async (req: AuthedRequest, res) => {
  const count = await prisma.notification.count({
    where: { userId: req.user!.userId, read: false },
  });
  res.json({ count });
});

notificationsRouter.post("/read-all", requireAuth, async (req: AuthedRequest, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.user!.userId, read: false },
    data: { read: true },
  });
  res.json({ ok: true });
});

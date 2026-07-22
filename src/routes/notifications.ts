import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthedRequest } from "../middleware/authGuard";

export const notificationsRouter = Router();

// ── List the current user's notifications (newest first) ────────────────────
notificationsRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, title: true, body: true, read: true, orderId: true, link: true, createdAt: true },
    });
    res.json({ notifications });
  } catch (err) {
    console.warn("[notifications] DB unreachable, returning empty list:", (err as Error)?.message);
    res.json({ notifications: [] });
  }
});

// ── Unread badge count ──────────────────────────────────────────────────────
notificationsRouter.get("/unread-count", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const count = await prisma.notification.count({
      where: { userId: req.user!.userId, read: false },
    });
    res.json({ count });
  } catch (err) {
    console.warn("[notifications] DB unreachable, returning count 0:", (err as Error)?.message);
    res.json({ count: 0 });
  }
});

// ── Mark all as read ────────────────────────────────────────────────────────
notificationsRouter.post("/read-all", requireAuth, async (req: AuthedRequest, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user!.userId, read: false },
      data: { read: true },
    });
    res.json({ ok: true });
  } catch (err) {
    console.warn("[notifications] DB unreachable, read-all skipped:", (err as Error)?.message);
    res.json({ ok: false });
  }
});

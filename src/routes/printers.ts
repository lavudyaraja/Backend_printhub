// Printer/kiosk management + live status listing (for app printer selection & admin).
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/authGuard";

export const printersRouter = Router();

// Public-ish: list online printers so students can pick a campus location.
printersRouter.get("/", requireAuth, async (_req, res) => {
  const printers = await prisma.printer.findMany({
    orderBy: { location: "asc" },
    select: {
      id: true,
      name: true,
      location: true,
      deviceId: true,
      status: true,
      paperLevel: true,
      tonerLevel: true,
    },
  });
  res.json({ printers });
});

// Admin: register a new kiosk/printer.
printersRouter.post("/", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { name, location, deviceId } = req.body;
  const printer = await prisma.printer.create({ data: { name, location, deviceId } });
  res.json({ printer });
});

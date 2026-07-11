// Kiosk endpoints — used by the kiosk screen at the printer.
// Flow: scan QR / enter code -> assign printer -> start printing.
// No payment checks — free printing.
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { dispatchToPrinter } from "../services/printQueue";

export const kioskRouter = Router();

// Validate an order by QR token or order code.
kioskRouter.post("/validate", async (req, res) => {
  const { code, token, deviceId } = req.body as {
    code?: string;
    token?: string;
    deviceId?: string;
  };

  const order = await prisma.order.findFirst({
    where: {
      OR: [
        token ? { printToken: token } : undefined,
        code ? { orderCode: code } : undefined,
      ].filter(Boolean) as any,
    },
    include: { document: true, printer: true, user: true },
  });

  if (!order) return res.status(404).json({ error: "Order not found" });
  if (token && order.printToken !== token) return res.status(403).json({ error: "Bad token" });
  if (!["PAID", "READY"].includes(order.status)) {
    return res.status(400).json({ error: `Order not ready (status: ${order.status})` });
  }

  // Bind to the kiosk's printer if the order didn't pre-select one.
  if (deviceId && !order.printerId) {
    const printer = await prisma.printer.findUnique({ where: { deviceId } });
    if (printer) {
      await prisma.order.update({ where: { id: order.id }, data: { printerId: printer.id } });
      order.printerId = printer.id;
    }
  }

  res.json({
    order: {
      id: order.id,
      orderCode: order.orderCode,
      status: order.status,
      copies: order.copies,
      colorMode: order.colorMode,
      sideMode: order.sideMode,
      pagesToPrint: order.pagesToPrint,
      fileName: order.document.fileName,
      user: order.user.name,
    },
  });
});

// User confirms print summary at kiosk -> start printing.
kioskRouter.post("/print", async (req, res) => {
  const { orderId, deviceId } = req.body;
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!["PAID", "READY"].includes(order.status)) {
    return res.status(400).json({ error: "Order not printable" });
  }

  if (deviceId && !order.printerId) {
    const printer = await prisma.printer.findUnique({ where: { deviceId } });
    if (printer) await prisma.order.update({ where: { id: orderId }, data: { printerId: printer.id } });
  }

  await dispatchToPrinter(orderId);
  res.json({ started: true });
});

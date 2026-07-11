// Print queue: turns a PAID order into a PrintJob and pushes it to the IoT device via MQTT.
// Files are served over HTTP from local disk — no cloud storage.
import path from "path";
import { prisma } from "../lib/prisma";
import { publishJob } from "../lib/mqtt";
import { emitOrderUpdate } from "./realtime";
import { createNotification, statusNotification } from "../lib/notify";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";

// Emit realtime status + persist a notification in one call.
async function pushStatus(userId: string, orderId: string, orderCode: string, status: string) {
  emitOrderUpdate(userId, orderId, status);
  const n = statusNotification(status, orderCode);
  if (n) await createNotification(userId, n.title, n.body, orderId);
}

// Called after order creation (or kiosk confirmation).
export async function enqueuePrint(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { document: true, printer: true },
  });
  if (!order || order.status !== "PAID") return;
  if (!order.printerId || !order.printer) {
    // No printer chosen yet — mark READY, user selects at kiosk.
    await prisma.order.update({ where: { id: orderId }, data: { status: "READY" } });
    await pushStatus(order.userId, orderId, order.orderCode, "READY");
    return;
  }
  await dispatchToPrinter(orderId);
}

// Push job to a specific printer's IoT agent via MQTT.
export async function dispatchToPrinter(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { document: true, printer: true },
  });
  if (!order || !order.printer || !order.document) return;

  const job = await prisma.printJob.upsert({
    where: { orderId },
    update: { status: "SENT", attempts: { increment: 1 }, printerId: order.printerId! },
    create: { orderId, printerId: order.printerId!, status: "SENT", attempts: 1 },
  });

  // Local HTTP URL — IoT device downloads the file directly from the backend.
  const fileUrl = `${BACKEND_URL}/api/documents/file/${order.document.fileKey}`;

  publishJob(order.printer.deviceId, {
    jobId: job.id,
    orderId: order.id,
    printToken: order.printToken,
    fileUrl,
    fileType: order.document.fileType,
    options: {
      colorMode: order.colorMode,
      sideMode: order.sideMode,
      copies: order.copies,
      pageRange: order.pageRange,
    },
  });

  await prisma.order.update({ where: { id: orderId }, data: { status: "PRINTING" } });
  await pushStatus(order.userId, orderId, order.orderCode, "PRINTING");
}

// Called when IoT reports job result (MQTT job-result topic).
export async function handleJobResult(payload: {
  orderId: string;
  jobId: string;
  success: boolean;
  error?: string;
}) {
  const order = await prisma.order.findUnique({
    where: { id: payload.orderId },
    include: { document: true },
  });
  if (!order) return;

  if (payload.success) {
    await prisma.printJob.update({
      where: { orderId: payload.orderId },
      data: { status: "DONE", finishedAt: new Date() },
    });
    await prisma.order.update({ where: { id: payload.orderId }, data: { status: "COMPLETED" } });

    // Delete local file after successful print.
    if (order.document && !order.document.deleted) {
      try {
        const { unlinkSync, existsSync, readdirSync } = await import("fs");
        const uploadsDir = path.join(__dirname, "../../uploads");
        const filePath = path.join(uploadsDir, order.document.fileKey);
        
        // Delete original file
        if (existsSync(filePath)) unlinkSync(filePath);
        
        // Delete page preview images
        if (existsSync(uploadsDir)) {
          const files = readdirSync(uploadsDir);
          for (const file of files) {
            if (file.startsWith(`${order.document.fileKey}_page_`)) {
              const previewPath = path.join(uploadsDir, file);
              if (existsSync(previewPath)) unlinkSync(previewPath);
            }
          }
        }
      } catch (e) {
        console.error("[cleanup] failed to delete local file", order.document.fileKey, e);
      }
      await prisma.document.update({
        where: { id: order.document.id },
        data: { deleted: true },
      });
    }
    await pushStatus(order.userId, payload.orderId, order.orderCode, "COMPLETED");
  } else {
    await prisma.printJob.update({
      where: { orderId: payload.orderId },
      data: { status: "ERROR", error: payload.error },
    });
    await prisma.order.update({ where: { id: payload.orderId }, data: { status: "FAILED" } });
    await pushStatus(order.userId, payload.orderId, order.orderCode, "FAILED");
  }
}

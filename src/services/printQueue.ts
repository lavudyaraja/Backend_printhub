// Print queue: turns a PAID order into a PrintJob and pushes it to the IoT device via MQTT.
// Files live in Backblaze B2; the agent downloads them via a short-lived signed URL.
import { prisma } from "../lib/prisma";
import { publishJob } from "../lib/mqtt";
import { emitOrderUpdate } from "./realtime";
import { createNotification, statusNotification } from "../lib/notify";
import { presignGet, deleteFileAndPreviews } from "../lib/storage";

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

  // ── Duplicate-print guard ────────────────────────────────────────
  // Atomically "claim" the order: only transition PAID/READY -> PRINTING.
  // If another scan/request already claimed it, updateMany affects 0 rows and
  // we stop here, so the job is published to MQTT exactly once.
  const claim = await prisma.order.updateMany({
    where: { id: orderId, status: { in: ["PAID", "READY"] } },
    data: { status: "PRINTING" },
  });
  if (claim.count === 0) {
    console.log(`[queue] order ${orderId} already claimed — skipping duplicate dispatch`);
    return;
  }

  const job = await prisma.printJob.upsert({
    where: { orderId },
    update: { status: "SENT", attempts: { increment: 1 }, printerId: order.printerId! },
    create: { orderId, printerId: order.printerId!, status: "SENT", attempts: 1 },
  });

  // Short-lived B2 signed URL — the IoT device downloads directly from storage.
  const fileUrl = await presignGet(order.document.fileKey, 15 * 60);

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

    // Delete the file from B2 immediately after a successful print (temp buffer).
    if (order.document && !order.document.deleted) {
      try {
        await deleteFileAndPreviews(order.document.fileKey);
      } catch (e) {
        console.error("[cleanup] failed to delete B2 file", order.document.fileKey, e);
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

// Create a notification for a user (best-effort — never throws into caller).
import { prisma } from "./prisma";
import { emitNotification } from "../services/realtime";

export async function createNotification(
  userId: string,
  title: string,
  body: string,
  orderId?: string
) {
  try {
    const n = await prisma.notification.create({
      data: { userId, title, body, orderId: orderId || null },
    });
    emitNotification(userId, n);
  } catch (e) {
    console.error("[notify] failed", e);
  }
}

// Human-friendly notification text for each order status.
export function statusNotification(status: string, orderCode: string) {
  switch (status) {
    case "PAID":
      return { title: "Order confirmed", body: `Order ${orderCode} is confirmed and ready to print.` };
    case "READY":
      return { title: "Ready to print", body: `Order ${orderCode} is ready. Scan your QR at any kiosk.` };
    case "PRINTING":
      return { title: "Printing started", body: `Order ${orderCode} is now printing.` };
    case "COMPLETED":
      return { title: "Print completed", body: `Order ${orderCode} has been printed. Collect it from the kiosk.` };
    case "FAILED":
      return { title: "Print failed", body: `Order ${orderCode} failed. Please try again at the kiosk.` };
    default:
      return null;
  }
}

// Complaint persistence. Kept out of the router so the ownership rules live in
// one place — every read is scoped to the signed-in user, and a complaint the
// user doesn't own is reported as missing rather than forbidden, so ids can't be
// probed.
import { nanoid } from "nanoid";
import { prisma } from "../lib/prisma";
import { issueRefund } from "../refunds/service";
import {
  CATEGORY_LABELS,
  COMPLAINT_SELECT,
  MAX_PHOTOS,
  type CreateComplaintInput,
} from "./types";

export interface UploadedPhoto {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/** Statuses a user is still allowed to withdraw from. */
const CANCELLABLE = ["OPEN", "IN_REVIEW"];

/**
 * Resolve the order and printer a complaint points at, dropping anything the
 * user doesn't own or that no longer exists. A bad reference must not fail the
 * whole submission: the report itself is still worth recording, and a user
 * standing at a broken machine shouldn't be blocked by a stale id.
 *
 * When an order is given but no printer, the order's printer is inherited —
 * that is the machine that actually failed.
 */
async function resolveLinks(userId: string, input: CreateComplaintInput) {
  let orderId: string | null = null;
  let printerId: string | null = null;
  let vendorId: string | null = null;

  if (input.orderId) {
    const order = await prisma.order.findFirst({
      where: { id: input.orderId, userId },
      select: { id: true, printerId: true, vendorId: true },
    });
    if (order) {
      orderId = order.id;
      printerId = order.printerId;
      vendorId = order.vendorId;
    }
  }

  if (input.printerId) {
    const printer = await prisma.printer.findUnique({
      where: { id: input.printerId },
      select: { id: true, vendorId: true },
    });
    if (printer) {
      printerId = printer.id;
      // Only adopt the printer's shop when it has one — never overwrite a vendor
      // already found from the order with null (the mobile report sends BOTH the
      // orderId and printerId, and the printer can be unlinked while the order
      // still records who took the money).
      if (printer.vendorId) vendorId = printer.vendorId;
    }
  }

  // Still no shop but we have a machine: resolve it from the printer's current
  // owner (a walk-up report names a printer, not an order).
  if (!vendorId && printerId) {
    const printer = await prisma.printer.findUnique({
      where: { id: printerId },
      select: { vendorId: true },
    });
    vendorId = printer?.vendorId ?? null;
  }

  return { orderId, printerId, vendorId };
}

/**
 * Notify the shop that owns the machine a complaint is about.
 *
 * The complaint carries a printerId, and a printer carries its vendor, whose
 * console login is the account to reach. When there's no printer (a payment or
 * points complaint with nothing physical behind it), there's no shop to tell —
 * that one is the platform's, and it stays in the admin queue.
 */
async function notifyComplaintVendor(
  vendorId: string | null,
  code: string,
  subject: string,
  orderId: string | null,
  refundRequested: boolean
): Promise<void> {
  if (!vendorId) return;
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { userId: true },
  });
  const vendorUserId = vendor?.userId;
  if (!vendorUserId) return;

  await prisma.notification.create({
    data: {
      userId: vendorUserId,
      title: refundRequested ? "Refund request on your shop" : "New complaint about your printer",
      body: refundRequested
        ? `${code} — ${subject}. The customer is asking for a refund. Review it and forward to the platform to decide.`
        : `${code} — ${subject}. Open your console to see the details.`,
      orderId,
      link: "/vendor/issues",
    },
  });
}

export async function createComplaint(
  userId: string,
  input: CreateComplaintInput,
  photos: UploadedPhoto[]
) {
  const { orderId, printerId, vendorId } = await resolveLinks(userId, input);
  const subject = input.subject?.trim() || CATEGORY_LABELS[input.category];
  // A refund needs an order to refund; an unattached report can't carry one.
  const refundRequested = Boolean(input.refundRequested && orderId);

  const complaint = await prisma.complaint.create({
    data: {
      code: "CMP-" + nanoid(6).toUpperCase(),
      userId,
      orderId,
      printerId,
      vendorId,
      refundRequested,
      category: input.category,
      subject,
      description: input.description,
      photos: {
        create: photos.slice(0, MAX_PHOTOS).map((p) => ({
          fileName: p.originalname || "photo.jpg",
          mimeType: p.mimetype || "image/jpeg",
          data: p.buffer,
          sizeBytes: p.size,
        })),
      },
    },
    select: COMPLAINT_SELECT,
  });

  // Give the user something in their notification list to point at, so a report
  // filed at a kiosk is traceable later without digging through the app.
  await prisma.notification
    .create({
      data: {
        userId,
        title: refundRequested ? "Refund request received" : "Complaint received",
        body: refundRequested
          ? `We've logged ${complaint.code} — ${subject}. The shop will review your refund and pass it to us to decide. You'll be notified either way.`
          : `We've logged ${complaint.code} — ${subject}. Our team will look into it shortly.`,
        orderId,
      },
    })
    .catch(() => {}); // a failed notification must not undo a filed complaint

  // Tell the shop that owns the machine, so the report reaches whoever can
  // actually walk over and fix it — the user → vendor half of the chain. The
  // admin half needs no notification: every complaint already surfaces in the
  // operations console's Disputes queue. Best-effort, and never blocks the
  // filing.
  await notifyComplaintVendor(vendorId, complaint.code, subject, orderId, refundRequested).catch(
    () => {}
  );

  return complaint;
}

export function listComplaints(userId: string) {
  return prisma.complaint.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: COMPLAINT_SELECT,
  });
}

export function getComplaint(userId: string, id: string) {
  return prisma.complaint.findFirst({
    where: { id, userId },
    select: COMPLAINT_SELECT,
  });
}

export async function countOpenComplaints(userId: string) {
  return prisma.complaint.count({ where: { userId, status: { in: ["OPEN", "IN_REVIEW"] } } });
}

export type CancelResult =
  | { ok: true; complaint: Awaited<ReturnType<typeof getComplaint>> }
  | { ok: false; reason: "NOT_FOUND" | "NOT_CANCELLABLE" };

export async function cancelComplaint(userId: string, id: string): Promise<CancelResult> {
  const existing = await prisma.complaint.findFirst({
    where: { id, userId },
    select: { id: true, status: true },
  });
  if (!existing) return { ok: false, reason: "NOT_FOUND" };
  if (!CANCELLABLE.includes(existing.status)) return { ok: false, reason: "NOT_CANCELLABLE" };

  const complaint = await prisma.complaint.update({
    where: { id: existing.id },
    data: { status: "CANCELLED" },
    select: COMPLAINT_SELECT,
  });
  return { ok: true, complaint };
}

/**
 * Fetch a photo's bytes. Access is *not* checked here — the caller is the
 * token-authenticated photo endpoint, where a signed, short-lived `?t=` token
 * scoped to this photo id is the credential. The complaintId is still part of
 * the lookup so a token minted for one complaint's photo can't be replayed
 * against a URL naming a different complaint.
 */
export function getPhotoBytes(complaintId: string, photoId: string) {
  return prisma.complaintPhoto.findFirst({
    where: { id: photoId, complaintId },
    select: { data: true, mimeType: true, fileName: true },
  });
}

// ── Vendor side ─────────────────────────────────────────────────────────────
// A shop sees the issues raised against its own machines and, for the ones that
// ask for money back, passes them up to the platform to decide — refunds are
// admin-only, so forwarding is the only move a shop has on a refund.

/** The statuses a vendor is still allowed to forward from. */
const FORWARDABLE = ["OPEN", "IN_REVIEW"];

export async function listComplaintsForVendor(
  vendorId: string,
  opts: { status?: string; limit?: number; skip?: number } = {}
) {
  const where: any = { vendorId };
  if (opts.status) where.status = opts.status;

  const [complaints, total] = await Promise.all([
    prisma.complaint.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(opts.limit ?? 50, 200),
      skip: opts.skip ?? 0,
      select: COMPLAINT_SELECT,
    }),
    prisma.complaint.count({ where }),
  ]);
  return { complaints, total };
}

export async function vendorComplaintStats(vendorId: string) {
  const rows = await prisma.complaint.groupBy({
    by: ["status"],
    where: { vendorId },
    _count: { _all: true },
  });
  const countFor = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
  return {
    total: rows.reduce((sum, r) => sum + r._count._all, 0),
    open: countFor("OPEN"),
    inReview: countFor("IN_REVIEW"),
    forwarded: countFor("FORWARDED"),
    refunded: countFor("REFUNDED"),
    resolved: countFor("RESOLVED"),
    rejected: countFor("REJECTED"),
  };
}

export type ForwardResult =
  | { ok: true; complaint: Awaited<ReturnType<typeof getComplaint>> }
  | { ok: false; reason: "NOT_FOUND" | "NOT_FORWARDABLE" };

/**
 * A shop hands a refund-bearing issue up to the platform. Scoped to the shop's
 * own vendorId so one shop can't touch another's queue, and reported as missing
 * (never forbidden) when it isn't theirs, so ids can't be probed.
 */
export async function forwardComplaintToAdmin(
  vendorId: string,
  complaintId: string,
  note?: string
): Promise<ForwardResult> {
  const existing = await prisma.complaint.findFirst({
    where: { id: complaintId, vendorId },
    select: { id: true, status: true, code: true, userId: true, subject: true, orderId: true },
  });
  if (!existing) return { ok: false, reason: "NOT_FOUND" };
  if (!FORWARDABLE.includes(existing.status)) return { ok: false, reason: "NOT_FORWARDABLE" };

  const complaint = await prisma.complaint.update({
    where: { id: existing.id },
    data: {
      status: "FORWARDED",
      forwardedAt: new Date(),
      forwardNote: note?.trim() || null,
    },
    select: COMPLAINT_SELECT,
  });

  // Keep the customer in the loop — their request has moved a step.
  await prisma.notification
    .create({
      data: {
        userId: existing.userId,
        title: "Your refund request was forwarded",
        body: `The shop has passed ${existing.code} to our team to decide. We'll let you know the outcome.`,
        orderId: existing.orderId,
      },
    })
    .catch(() => {});

  return { ok: true, complaint };
}

// ── Admin side ──────────────────────────────────────────────────────────────

export type ComplaintRefundResult =
  | { ok: true; complaint: Awaited<ReturnType<typeof getComplaint>>; pointsCredited: number }
  | { ok: false; reason: "NOT_FOUND" | "NO_ORDER" | "REFUND_FAILED"; detail?: string };

/**
 * Staff grant the refund an issue asked for. This is the only place a
 * complaint-driven refund is issued — vendors forward, admins decide.
 *
 * Leans on issueRefund's idempotency (unique on Refund.orderId), so a double
 * click credits once and reports the existing refund the second time.
 */
export async function refundComplaint(
  complaintId: string,
  adminUserId: string,
  note?: string
): Promise<ComplaintRefundResult> {
  const complaint = await prisma.complaint.findUnique({
    where: { id: complaintId },
    select: {
      id: true,
      code: true,
      userId: true,
      orderId: true,
      vendorId: true,
      order: { select: { orderCode: true } },
    },
  });
  if (!complaint) return { ok: false, reason: "NOT_FOUND" };
  if (!complaint.orderId) return { ok: false, reason: "NO_ORDER" };

  const result = await issueRefund({
    orderId: complaint.orderId,
    reason: "ADMIN_GOODWILL",
    origin: "MANUAL",
    issuedById: adminUserId,
    note: note?.trim() || `Refund for complaint ${complaint.code}`,
  });
  if (!result.ok) return { ok: false, reason: "REFUND_FAILED", detail: result.error };

  const updated = await prisma.complaint.update({
    where: { id: complaint.id },
    data: {
      status: "REFUNDED",
      refundId: result.refundId,
      resolution: note?.trim() || "Refund approved and credited to your Points.",
      resolvedAt: new Date(),
    },
    select: COMPLAINT_SELECT,
  });

  // issueRefund already tells the customer their points are back; this closes
  // the loop on the *complaint* for both sides — the admin → user and admin →
  // vendor half of the chain.
  await prisma.notification
    .create({
      data: {
        userId: complaint.userId,
        title: "Refunded successfully",
        body: `Your refund for ${complaint.code} has been approved. ${result.pointsCredited} points are back in your balance.`,
        orderId: complaint.orderId,
      },
    })
    .catch(() => {});

  if (complaint.vendorId) {
    const vendor = await prisma.vendor.findUnique({
      where: { id: complaint.vendorId },
      select: { userId: true },
    });
    if (vendor?.userId) {
      await prisma.notification
        .create({
          data: {
            userId: vendor.userId,
            title: "Refund issued by the platform",
            body: `${complaint.code}${complaint.order?.orderCode ? ` (order ${complaint.order.orderCode})` : ""} was refunded to the customer.`,
            orderId: complaint.orderId,
            link: "/vendor/issues",
          },
        })
        .catch(() => {});
    }
  }

  return { ok: true, complaint: updated, pointsCredited: result.pointsCredited };
}

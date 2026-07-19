// Complaint persistence. Kept out of the router so the ownership rules live in
// one place — every read is scoped to the signed-in user, and a complaint the
// user doesn't own is reported as missing rather than forbidden, so ids can't be
// probed.
import { nanoid } from "nanoid";
import { prisma } from "../lib/prisma";
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

  if (input.orderId) {
    const order = await prisma.order.findFirst({
      where: { id: input.orderId, userId },
      select: { id: true, printerId: true },
    });
    if (order) {
      orderId = order.id;
      printerId = order.printerId;
    }
  }

  if (input.printerId) {
    const printer = await prisma.printer.findUnique({
      where: { id: input.printerId },
      select: { id: true },
    });
    if (printer) printerId = printer.id;
  }

  return { orderId, printerId };
}

export async function createComplaint(
  userId: string,
  input: CreateComplaintInput,
  photos: UploadedPhoto[]
) {
  const { orderId, printerId } = await resolveLinks(userId, input);
  const subject = input.subject?.trim() || CATEGORY_LABELS[input.category];

  const complaint = await prisma.complaint.create({
    data: {
      code: "CMP-" + nanoid(6).toUpperCase(),
      userId,
      orderId,
      printerId,
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
        title: "Complaint received",
        body: `We've logged ${complaint.code} — ${subject}. Our team will look into it shortly.`,
        orderId,
      },
    })
    .catch(() => {}); // a failed notification must not undo a filed complaint

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

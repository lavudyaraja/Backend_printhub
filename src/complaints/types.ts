// Shapes and validation for user-raised complaints.
//
// The category list is duplicated as a plain array (rather than read off the
// Prisma enum) so the request schema can be validated before the database is
// touched, and so the same order is used everywhere the categories are listed.
import { z } from "zod";

export const COMPLAINT_CATEGORIES = [
  "PRINTER_NOT_WORKING",
  "OUT_OF_TONER",
  "PAPER_JAM",
  "OUT_OF_PAPER",
  "POOR_PRINT_QUALITY",
  "INCOMPLETE_PRINT",
  "BLANK_PAGES",
  "PAYMENT_OR_POINTS",
  "OTHER",
] as const;

export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

/** Fallback subject when the user doesn't type one — every complaint has a title. */
export const CATEGORY_LABELS: Record<ComplaintCategory, string> = {
  PRINTER_NOT_WORKING: "Printer not working",
  OUT_OF_TONER: "Out of toner / ink",
  PAPER_JAM: "Paper jam",
  OUT_OF_PAPER: "Out of paper",
  POOR_PRINT_QUALITY: "Poor print quality",
  INCOMPLETE_PRINT: "Incomplete print",
  BLANK_PAGES: "Blank pages printed",
  PAYMENT_OR_POINTS: "Payment or points issue",
  OTHER: "Other issue",
};

/** At most this many photos per complaint, and this big each. */
export const MAX_PHOTOS = 4;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export const ACCEPTED_IMAGE_MIMES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

// The body arrives as multipart/form-data alongside the photos, so every field
// is a string on the wire — hence coercion rather than plain types.
export const createComplaintSchema = z.object({
  category: z.enum(COMPLAINT_CATEGORIES),
  subject: z.string().trim().max(120).optional(),
  description: z
    .string()
    .trim()
    .min(10, "Please describe the problem in at least 10 characters.")
    .max(2000),
  orderId: z.string().trim().min(1).optional(),
  printerId: z.string().trim().min(1).optional(),
});

export type CreateComplaintInput = z.infer<typeof createComplaintSchema>;

/** Fields the app is allowed to see. Photos are exposed as ids, never as bytes. */
export const COMPLAINT_SELECT = {
  id: true,
  code: true,
  category: true,
  subject: true,
  description: true,
  status: true,
  resolution: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  orderId: true,
  printerId: true,
  order: { select: { id: true, orderCode: true, status: true } },
  printer: { select: { id: true, name: true, shopName: true, locationName: true } },
  photos: { select: { id: true, fileName: true, mimeType: true, sizeBytes: true } },
} as const;

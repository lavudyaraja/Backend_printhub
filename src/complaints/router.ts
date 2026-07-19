// User-facing complaint API. Every route is scoped to the signed-in account:
// a user files and tracks their own reports and nothing else. Staff triage lives
// in the admin surface, not here.
import { Router, type NextFunction, type RequestHandler, type Response } from "express";
import multer from "multer";
import { requireAuth, type AuthedRequest } from "../middleware/authGuard";
import { signFileToken, verifyFileToken } from "../lib/fileToken";
import {
  ACCEPTED_IMAGE_MIMES,
  CATEGORY_LABELS,
  COMPLAINT_CATEGORIES,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  createComplaintSchema,
} from "./types";
import {
  cancelComplaint,
  countOpenComplaints,
  createComplaint,
  getComplaint,
  getPhotoBytes,
  listComplaints,
} from "./service";

export const complaintsRouter = Router();

const uploadPhotos = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || "").toLowerCase();
    // Some Android pickers hand over a generic content-type, so fall back to the
    // extension rather than rejecting a perfectly good photo.
    const looksLikeImage =
      (ACCEPTED_IMAGE_MIMES as readonly string[]).includes(mime) ||
      mime.startsWith("image/") ||
      /\.(png|jpe?g|webp|heic|heif)$/i.test(file.originalname || "");
    if (!looksLikeImage) return cb(new Error("Only image files can be attached."));
    cb(null, true);
  },
});

/**
 * Attach a short-lived access token to each photo. <Image> fetches the URL
 * directly and can't send an Authorization header, so the token in the query
 * string is what proves the caller may read the bytes — the same arrangement
 * the document previews use.
 */
function withPhotoTokens<T extends { photos: { id: string }[] }>(complaint: T) {
  return {
    ...complaint,
    photos: complaint.photos.map((p) => {
      const access = signFileToken(p.id);
      return { ...p, token: access.token, tokenExpiresAt: access.expiresAt };
    }),
  };
}

/**
 * Express 4 does not forward a rejected promise from an async handler to the
 * error middleware — the request simply hangs until the client gives up. Every
 * async handler below therefore goes through this, so a database failure comes
 * back as a JSON 500 the app can actually show.
 */
function asyncRoute(
  handler: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    handler(req as AuthedRequest, res, next).catch(next);
  };
}

// ── The category catalog, so the app and server never disagree ──────────────
complaintsRouter.get("/categories", (_req, res) => {
  res.json({
    categories: COMPLAINT_CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] })),
    maxPhotos: MAX_PHOTOS,
    maxPhotoBytes: MAX_PHOTO_BYTES,
  });
});

// ── File a complaint (multipart: fields + up to MAX_PHOTOS images) ──────────
complaintsRouter.post(
  "/",
  requireAuth,
  uploadPhotos.array("photos", MAX_PHOTOS),
  asyncRoute(async (req, res) => {
    const parsed = createComplaintSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }

    const files = (req.files as Express.Multer.File[] | undefined) || [];
    const complaint = await createComplaint(req.user!.userId, parsed.data, files);
    res.status(201).json({ complaint: withPhotoTokens(complaint) });
  })
);

// ── My complaints, newest first ─────────────────────────────────────────────
complaintsRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const complaints = await listComplaints(req.user!.userId);
    res.json({ complaints: complaints.map(withPhotoTokens) });
  })
);

// ── Badge count for the dashboard ───────────────────────────────────────────
complaintsRouter.get(
  "/open-count",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json({ count: await countOpenComplaints(req.user!.userId) });
  })
);

// ── One complaint ───────────────────────────────────────────────────────────
complaintsRouter.get(
  "/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const complaint = await getComplaint(req.user!.userId, req.params.id);
    if (!complaint) return res.status(404).json({ error: "Complaint not found" });
    res.json({ complaint: withPhotoTokens(complaint) });
  })
);

// ── Withdraw a complaint ────────────────────────────────────────────────────
complaintsRouter.post(
  "/:id/cancel",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await cancelComplaint(req.user!.userId, req.params.id);
    if (!result.ok) {
      if (result.reason === "NOT_FOUND") return res.status(404).json({ error: "Complaint not found" });
      return res.status(409).json({ error: "This complaint can no longer be withdrawn." });
    }
    res.json({ complaint: withPhotoTokens(result.complaint!) });
  })
);

// ── Serve an attached photo ─────────────────────────────────────────────────
// Credential is the `?t=` token (see withPhotoTokens); a bearer header alone is
// not enough because the token is what scopes access to this one photo.
complaintsRouter.get(
  "/:id/photos/:photoId",
  asyncRoute(async (req, res) => {
    if (!verifyFileToken(req.params.photoId, req.query.t)) {
      return res.status(404).json({ error: "Not found" });
    }

    const photo = await getPhotoBytes(req.params.id, req.params.photoId);
    if (!photo) return res.status(404).json({ error: "Not found" });

    res.setHeader("Content-Type", photo.mimeType || "image/jpeg");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(photo.fileName)}"`);
    res.send(Buffer.from(photo.data));
  })
);

// Multer rejects (file too large, too many files, not an image) surface as
// thrown errors. Without this they'd reach the default handler and come back as
// an HTML 500, which the app renders as "something went wrong" instead of the
// actual reason.
complaintsRouter.use((err: any, _req: any, res: any, next: any) => {
  if (res.headersSent) return next(err);
  if (err?.code === "LIMIT_FILE_SIZE") {
    const mb = Math.round(MAX_PHOTO_BYTES / (1024 * 1024));
    return res.status(413).json({ error: `Each photo must be under ${mb} MB.` });
  }
  if (err?.code === "LIMIT_FILE_COUNT" || err?.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({ error: `You can attach up to ${MAX_PHOTOS} photos.` });
  }
  if (err?.message === "Only image files can be attached.") {
    return res.status(400).json({ error: err.message });
  }
  console.error("[complaints]", err);
  res.status(500).json({ error: "Could not process the complaint. Please try again." });
});

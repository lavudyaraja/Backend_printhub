// User document upload. Files are stored in Neon (Document.fileData) as a
// temporary buffer — no external object storage. A cleanup sweep removes
// documents that were never turned into a paid order.
import { Router } from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import { prisma } from "../lib/prisma";
import { config } from "../lib/config";
import { imageToUrf } from "../lib/urf";
import { imageToPwgRaster } from "../lib/pwgRaster";
import { requireAuth, type AuthedRequest } from "../middleware/authGuard";
import { verifyToken } from "../lib/auth";
import { signFileToken, verifyFileToken } from "../lib/fileToken";

export const documentsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
});

function detectType(mime: string, name: string): "pdf" | "image" | "docx" | "pptx" | "other" {
  const m = (mime || "").toLowerCase();
  const n = (name || "").toLowerCase();
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (m.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic)$/.test(n)) return "image";
  if (m.includes("wordprocessingml") || n.endsWith(".docx")) return "docx";
  if (m.includes("presentationml") || n.endsWith(".pptx")) return "pptx";
  return "other";
}

async function countPdfPages(buf: Buffer): Promise<number> {
  try {
    const pdf = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    return Math.max(1, pdf.getPageCount());
  } catch {
    return 1;
  }
}

// ── Upload a document ───────────────────────────────────────────────────────
documentsRouter.post("/upload", requireAuth, upload.single("file"), async (req: AuthedRequest, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded." });

  const fileType = detectType(file.mimetype, file.originalname);
  const pageCount = fileType === "pdf" ? await countPdfPages(file.buffer) : 1;

  const doc = await prisma.document.create({
    data: {
      userId: req.user!.userId,
      fileName: file.originalname || `upload.${fileType}`,
      fileType,
      fileKey: `neon/${req.user!.userId}`,
      mimeType: file.mimetype || "application/octet-stream",
      fileData: file.buffer,
      sizeBytes: file.size,
      pageCount,
    },
    select: { id: true, fileName: true, fileType: true, pageCount: true },
  });

  // Hand back an access token with the upload so the app can preview the file
  // straight away without a second round trip.
  const access = signFileToken(doc.id);
  res.json({
    tempKey: doc.id,
    fileName: doc.fileName,
    fileType: doc.fileType,
    pageCount: doc.pageCount,
    fileToken: access.token,
    fileTokenExpiresAt: access.expiresAt,
  });
});

// ── Mint an access token for a document you own ─────────────────────────────
// The raw-file endpoint can't require an Authorization header (see serveFile),
// so ownership is proved here, once, in exchange for a short-lived token.
documentsRouter.get("/:id/access", requireAuth, async (req: AuthedRequest, res) => {
  const doc = await prisma.document.findUnique({
    where: { id: req.params.id },
    select: { userId: true, deleted: true },
  });
  if (!doc || doc.deleted) return res.status(404).json({ error: "Not found" });
  if (doc.userId !== req.user!.userId) return res.status(403).json({ error: "Forbidden" });

  const access = signFileToken(req.params.id);
  res.json({ token: access.token, expiresAt: access.expiresAt });
});

// ── Keep or delete a printed file ───────────────────────────────────────────
// Once a print finishes the app asks the user what to happen to their document.
// Both answers land here; doing nothing leaves the sweeper to delete it, so the
// privacy-preserving outcome is the one that needs no action.

/** How long "keep" keeps it. Long enough to reprint, short enough to still be temporary. */
const KEEP_DAYS = 7;

documentsRouter.post("/:id/keep", requireAuth, async (req: AuthedRequest, res) => {
  const doc = await prisma.document.findUnique({
    where: { id: req.params.id },
    select: { userId: true, deleted: true },
  });
  if (!doc || doc.deleted) return res.status(404).json({ error: "Not found" });
  if (doc.userId !== req.user!.userId) return res.status(404).json({ error: "Not found" });

  const keepUntil = new Date(Date.now() + KEEP_DAYS * 24 * 60 * 60 * 1000);
  await prisma.document.update({ where: { id: req.params.id }, data: { keepUntil } });
  res.json({ ok: true, keepUntil, keepDays: KEEP_DAYS });
});

documentsRouter.delete("/:id/file", requireAuth, async (req: AuthedRequest, res) => {
  const doc = await prisma.document.findUnique({
    where: { id: req.params.id },
    select: { userId: true },
  });
  if (!doc) return res.status(404).json({ error: "Not found" });
  if (doc.userId !== req.user!.userId) return res.status(404).json({ error: "Not found" });

  // The bytes go; the row stays so the order history still has a filename to
  // show. Already-deleted is treated as success — the user asked for it gone,
  // and it is.
  await prisma.document.update({
    where: { id: req.params.id },
    data: { fileData: null, deleted: true, keepUntil: null },
  });
  res.json({ ok: true, deleted: true });
});

// ── Serve the raw file (used for previews and for printing) ─────────────────
// Access needs a short-lived `?t=` token from /:id/access — RN's <Image> and
// FileSystem.downloadAsync can't send an Authorization header, so the token
// carries the credential instead. Only non-deleted files are served.
//
// Two shapes are exposed:
//   /file/:id              — plain
//   /file/:id/:name        — same bytes, but the URL ends in the real filename.
// The trailing name matters: the Office web viewer infers the document type
// from the URL's extension, and hangs on an extension-less URL.
// "1-5, 8, 11-13" → [1,2,3,4,5,8,11,12,13], clamped to [1, max].
function parseRange(s: string, max: number): number[] {
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let i = Math.max(1, a); i <= Math.min(max, b); i++) out.add(i);
    } else {
      const n = parseInt(t, 10);
      if (!isNaN(n) && n >= 1 && n <= max) out.add(n);
    }
  }
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * Build a PDF containing only `range`'s pages. Returns null when the range is
 * empty or covers everything, so the caller can just serve the original bytes.
 */
async function subsetPdf(buf: Uint8Array, range: string): Promise<Uint8Array | null> {
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const total = src.getPageCount();
  const wanted = parseRange(range, total);
  if (wanted.length === 0 || wanted.length === total) return null;

  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, wanted.map((p) => p - 1)); // 0-indexed
  copied.forEach((page) => out.addPage(page));
  return out.save();
}

/**
 * Wrap a raw image (PNG/JPEG) into a single-page PDF sized to the image, so it
 * can be printed over IPP (which expects application/pdf). Returns null for
 * formats pdf-lib can't embed (webp/gif/heic) — the caller then serves the
 * original bytes.
 */
async function imageToPdf(buf: Uint8Array, mime: string): Promise<Uint8Array | null> {
  const pdf = await PDFDocument.create();
  const isPng = mime.includes("png") || (buf[0] === 0x89 && buf[1] === 0x50);
  const img = isPng ? await pdf.embedPng(buf) : await pdf.embedJpg(buf);
  const page = pdf.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  return pdf.save();
}

/**
 * Ownership check for the raw-file endpoint. A URL fetched by <Image>, by
 * FileSystem.downloadAsync or by a document viewer carries no Authorization
 * header, so a short-lived `?t=` token is the primary credential; a bearer
 * header is still honoured for callers that can send one.
 */
function mayReadDocument(req: any, ownerId: string): boolean {
  if (verifyFileToken(req.params.id, req.query.t)) return true;

  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    try {
      return verifyToken(header.slice(7)).userId === ownerId;
    } catch {
      return false;
    }
  }
  return false;
}

async function serveFile(req: any, res: any) {
  const doc = await prisma.document.findUnique({
    where: { id: req.params.id },
    select: { fileData: true, mimeType: true, fileName: true, fileType: true, deleted: true, userId: true },
  });
  if (!doc || doc.deleted || !doc.fileData) return res.status(404).json({ error: "Not found" });

  // 404 rather than 403: an unauthorised caller shouldn't learn that this id
  // exists at all.
  if (!mayReadDocument(req, doc.userId)) return res.status(404).json({ error: "Not found" });

  // The bytes are private — keep them out of shared caches and viewer proxies.
  res.setHeader("Cache-Control", "private, no-store");

  let body: Uint8Array = doc.fileData;

  // ?pages=1-20 → serve just those pages. This is what the app previews AND what
  // it sends to the printer, so the user is shown and charged for the same pages
  // that actually come out. Only PDFs can be subset — there is no page model for
  // Office formats without a converter.
  const range = typeof req.query.pages === "string" ? req.query.pages : "";
  if (range && doc.fileType === "pdf") {
    try {
      const subset = await subsetPdf(body, range);
      if (subset) body = subset;
    } catch (e) {
      console.error("[documents] pdf subset failed, serving full file:", e);
    }
  }

  // ?format=pwg → PWG-Raster, the format IPP Everywhere printers must accept.
  if (req.query.format === "pwg" && doc.fileType === "image") {
    try {
      const pwg = await imageToPwgRaster(Buffer.from(body));
      res.setHeader("Content-Type", "image/pwg-raster");
      res.setHeader("Content-Disposition", `inline; filename="print.pwg"`);
      res.setHeader("Cache-Control", "private, no-store");
      return res.send(pwg);
    } catch (e) {
      console.error("[documents] image→pwg failed:", e);
      return res.status(500).json({ error: "Could not rasterise the image for printing." });
    }
  }

  // ?format=urf → the app wants Apple Raster so it can print the image directly
  // over IPP (no OS dialog). Only images can be rasterised this way.
  if (req.query.format === "urf" && doc.fileType === "image") {
    try {
      const urf = await imageToUrf(Buffer.from(body));
      res.setHeader("Content-Type", "image/urf");
      res.setHeader("Content-Disposition", `inline; filename="print.urf"`);
      res.setHeader("Cache-Control", "private, no-store");
      return res.send(urf);
    } catch (e) {
      console.error("[documents] image→urf failed:", e);
      return res.status(500).json({ error: "Could not rasterise the image for printing." });
    }
  }

  // ?format=pdf → the caller (direct-print) needs a real PDF. Printers speak IPP
  // with document-format application/pdf, so an image must be wrapped in a PDF
  // page or the printer rejects the job. PDFs already qualify and pass through.
  if (req.query.format === "pdf" && doc.fileType === "image") {
    try {
      const wrapped = await imageToPdf(body, doc.mimeType || "");
      if (wrapped) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="print.pdf"`);
        res.setHeader("Cache-Control", "private, no-store");
        return res.send(Buffer.from(wrapped));
      }
    } catch (e) {
      console.error("[documents] image→pdf failed, serving original:", e);
    }
  }

  res.setHeader("Content-Type", doc.mimeType || "application/octet-stream");
  // inline + the real filename so viewers can also fall back to the header.
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.fileName || "document")}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(Buffer.from(body));
}

documentsRouter.get("/file/:id", serveFile);
documentsRouter.get("/file/:id/:name", serveFile);

// Alias so the mobile "temp" preview path resolves for images. The query string
// is carried across — dropping it would strip the `?t=` access token.
documentsRouter.get("/preview/temp/:id", (req, res) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  res.redirect(`/api/documents/file/${req.params.id}${qs}`);
});

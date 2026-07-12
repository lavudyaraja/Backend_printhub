// Document upload — files are stored ONLY in Backblaze B2 (temporary buffer).
// Nothing is written to persistent local disk; the OS temp dir is used briefly
// just to run the PDF→image preview conversion, then wiped.
import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import pdfParse from "pdf-parse";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthedRequest } from "../middleware/authGuard";
import { renderPdfPageToPng } from "../lib/pdf";
import { putObject, getObjectBuffer } from "../lib/storage";

export const documentsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

const ALLOWED: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/png": "image",
  "image/jpeg": "image",
};

const PREVIEW_MIME = "image/png";

// Upload a document → stored in B2.
documentsRouter.post(
  "/upload",
  requireAuth,
  upload.single("file"),
  async (req: AuthedRequest, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file" });
    const fileType = ALLOWED[file.mimetype];
    if (!fileType) return res.status(400).json({ error: "Unsupported file type" });

    let pageCount = 1;
    if (fileType === "pdf") {
      try {
        pageCount = (await pdfParse(file.buffer)).numpages || 1;
      } catch {
        pageCount = 1;
      }
    }

    const ext = file.originalname.split(".").pop() || "bin";
    const fileKey = `${nanoid()}.${ext}`;

    try {
      await putObject(fileKey, file.buffer, file.mimetype);
    } catch (e) {
      console.error("[upload] B2 put failed", e);
      return res.status(500).json({ error: "Storage upload failed" });
    }

    const doc = await prisma.document.create({
      data: {
        userId: req.user!.userId,
        fileName: file.originalname,
        fileType,
        fileKey, // B2 object key
        sizeBytes: file.size,
        pageCount,
      },
    });

    res.json({ document: doc });
  }
);

// Serve a document file (fallback download path; IoT normally uses a signed URL).
documentsRouter.get("/file/:fileKey", async (req, res) => {
  const buf = await getObjectBuffer(req.params.fileKey);
  if (!buf) return res.status(404).json({ error: "File not found" });
  res.send(buf);
});

// Serve a rendered page image for preview. PDF pages are converted lazily and
// cached back into B2 as "<fileKey>_page_N.png".
documentsRouter.get("/preview/:fileKey/:page", async (req, res) => {
  const { fileKey, page } = req.params;
  const doc = await prisma.document.findFirst({ where: { fileKey, deleted: false } });
  if (!doc) return res.status(404).json({ error: "Document not found" });

  if (doc.fileType === "image") {
    const buf = await getObjectBuffer(fileKey);
    if (!buf) return res.status(404).json({ error: "File not found" });
    return res.type(doc.fileName.endsWith(".png") ? "image/png" : "image/jpeg").send(buf);
  }

  if (doc.fileType !== "pdf") {
    return res.status(400).json({ error: "Preview not supported for this file type" });
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const previewKey = `${fileKey}_page_${pageNum}.png`;

  // Serve from cache if this page was already rendered.
  let preview = await getObjectBuffer(previewKey);
  if (!preview) {
    // Render the requested page from the PDF (pulled from B2) and cache it back.
    const pdfBuf = await getObjectBuffer(fileKey);
    if (!pdfBuf) return res.status(404).json({ error: "File not found" });
    try {
      preview = await renderPdfPageToPng(pdfBuf, pageNum);
      await putObject(previewKey, preview, PREVIEW_MIME);
    } catch (err) {
      console.error("[preview] render failed", err);
      return res.status(404).json({ error: "Preview page not found" });
    }
  }

  res.type(PREVIEW_MIME).send(preview);
});

// List user's documents.
documentsRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const docs = await prisma.document.findMany({
    where: { userId: req.user!.userId, deleted: false },
    orderBy: { createdAt: "desc" },
  });
  res.json({ documents: docs });
});

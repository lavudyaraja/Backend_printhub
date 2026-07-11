// Document upload — stored in local memory (no cloud storage).
// Counts PDF pages so the UI can show a page count.
import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import pdfParse from "pdf-parse";
import path from "path";
import fs from "fs";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthedRequest } from "../middleware/authGuard";
import { convertPdfToImages } from "../lib/pdf";

export const documentsRouter = Router();

// Store uploaded files in a local "uploads/" directory next to src/.
const UPLOAD_DIR = path.join(__dirname, "../../uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

// Upload a document.
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

    // Save to local disk.
    const ext = file.originalname.split(".").pop() || "bin";
    const fileKey = `${nanoid()}.${ext}`;
    const filePath = path.join(UPLOAD_DIR, fileKey);
    fs.writeFileSync(filePath, file.buffer);



    const doc = await prisma.document.create({
      data: {
        userId: req.user!.userId,
        fileName: file.originalname,
        fileType,
        fileKey,      // local filename (no bucket path)
        sizeBytes: file.size,
        pageCount,
      },
    });

    res.json({ document: doc });
  }
);

// Serve a document file (for IoT device download).
documentsRouter.get("/file/:fileKey", async (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.fileKey);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
  res.sendFile(filePath);
});

// Serve a rendered page image for preview.
documentsRouter.get("/preview/:fileKey/:page", async (req, res) => {
  const { fileKey, page } = req.params;
  const doc = await prisma.document.findFirst({
    where: { fileKey, deleted: false },
  });
  if (!doc) return res.status(404).json({ error: "Document not found" });

  if (doc.fileType === "image") {
    const filePath = path.join(UPLOAD_DIR, fileKey);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
    return res.sendFile(filePath);
  }

  if (doc.fileType === "pdf") {
    const pageImageName = `${fileKey}_page_${page}.png`;
    let filePath = path.join(UPLOAD_DIR, pageImageName);
    
    if (!fs.existsSync(filePath)) {
      const pdfPath = path.join(UPLOAD_DIR, fileKey);
      if (fs.existsSync(pdfPath)) {
        try {
          await convertPdfToImages(pdfPath, UPLOAD_DIR, fileKey);
        } catch (err) {
          console.error("Failed to generate PDF previews on-the-fly:", err);
        }
      }
    }

    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    } else {
      return res.status(404).json({ error: "Preview page not found" });
    }
  }

  return res.status(400).json({ error: "Preview not supported for this file type" });
});

// List user's documents.
documentsRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const docs = await prisma.document.findMany({
    where: { userId: req.user!.userId, deleted: false },
    orderBy: { createdAt: "desc" },
  });
  res.json({ documents: docs });
});

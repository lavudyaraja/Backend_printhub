// Temporary storage: uploaded files + rendered previews are auto-deleted 2 minutes
// after upload. Nothing is retained long-term (privacy). A sweeper runs every 30s.
import fs from "fs";
import path from "path";
import { prisma } from "./prisma";

const UPLOAD_DIR = path.join(__dirname, "../../uploads");
const TTL_MS = 2 * 60 * 1000; // 2 minutes

function removeFilesFor(fileKey: string) {
  try {
    const main = path.join(UPLOAD_DIR, fileKey);
    if (fs.existsSync(main)) fs.unlinkSync(main);
    if (fs.existsSync(UPLOAD_DIR)) {
      for (const f of fs.readdirSync(UPLOAD_DIR)) {
        if (f.startsWith(`${fileKey}_page_`)) fs.unlinkSync(path.join(UPLOAD_DIR, f));
      }
    }
  } catch (e) {
    console.error("[cleanup] failed to remove", fileKey, e);
  }
}

async function sweep() {
  const cutoff = new Date(Date.now() - TTL_MS);
  const stale = await prisma.document.findMany({
    where: { deleted: false, createdAt: { lt: cutoff } },
  });
  for (const doc of stale) {
    removeFilesFor(doc.fileKey);
    await prisma.document.update({ where: { id: doc.id }, data: { deleted: true } });
  }
  if (stale.length) console.log(`[cleanup] removed ${stale.length} expired file(s)`);
}

export function startCleanup() {
  setInterval(() => sweep().catch((e) => console.error("[cleanup]", e)), 30_000);
  console.log("[cleanup] temporary-file sweeper started (2 min TTL)");
}

// Temporary storage sweeper: any uploaded file (+ its cached preview pages) that
// was never printed is deleted from Backblaze B2 after a short TTL. Nothing is
// retained long-term (privacy). Runs every 30s.
import { prisma } from "./prisma";
import { deleteFileAndPreviews, storageConfigured } from "./storage";

const TTL_MS = 10 * 60 * 1000; // 10 minutes — enough to reach a kiosk and print

async function sweep() {
  if (!storageConfigured()) return;
  const cutoff = new Date(Date.now() - TTL_MS);
  const stale = await prisma.document.findMany({
    where: { deleted: false, createdAt: { lt: cutoff } },
  });
  for (const doc of stale) {
    try {
      await deleteFileAndPreviews(doc.fileKey);
    } catch (e) {
      console.error("[cleanup] failed to remove", doc.fileKey, e);
    }
    await prisma.document.update({ where: { id: doc.id }, data: { deleted: true } });
  }
  if (stale.length) console.log(`[cleanup] removed ${stale.length} expired file(s) from B2`);
}

export function startCleanup() {
  setInterval(() => sweep().catch((e) => console.error("[cleanup]", e)), 30_000);
  console.log("[cleanup] temporary-file sweeper started (10 min TTL, B2)");
}

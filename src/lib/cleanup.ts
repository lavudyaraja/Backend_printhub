// Temp-file sweeper. Documents live in Neon only as a short-lived buffer:
//   • uploads with no order after 2h are deleted,
//   • file bytes are cleared once their order is COMPLETED (keep the metadata),
//   • unless the user asked to keep the file, and that window hasn't passed.
// Nothing is retained long-term (privacy + DB size).
import { prisma } from "./prisma";

const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours
const SWEEP_MS = 30 * 60 * 1000;     // every 30 min

// After a print finishes the app asks whether to delete the file or keep it.
// Sweeping the moment the order completes would race that prompt and delete the
// document out from under a user who was about to choose "keep", so a completed
// order is left alone for this long before the default (delete) is applied.
const DECISION_GRACE_MS = 60 * 60 * 1000; // 1 hour

async function sweep() {
  const now = new Date();
  const cutoff = new Date(Date.now() - STALE_MS);
  const graceCutoff = new Date(Date.now() - DECISION_GRACE_MS);

  // 1) Orphan uploads (never turned into an order) → delete.
  const orphans = await prisma.document.deleteMany({
    where: { createdAt: { lt: cutoff }, order: null, deleted: false },
  });

  // 2) Completed orders → drop the stored bytes, keep the record.
  const done = await prisma.document.updateMany({
    where: {
      deleted: false,
      fileData: { not: null },
      OR: [
        // No keep request: swept once the user has had time to answer the prompt.
        { keepUntil: null, order: { status: "COMPLETED", updatedAt: { lt: graceCutoff } } },
        // Keep was requested, and that window has now run out.
        { keepUntil: { lt: now }, order: { status: "COMPLETED" } },
      ],
    },
    data: { fileData: null, deleted: true },
  });

  if (orphans.count || done.count) {
    console.log(`[cleanup] removed ${orphans.count} orphan upload(s), cleared ${done.count} completed file(s)`);
  }
}

export function startCleanup() {
  setInterval(() => sweep().catch((e) => console.error("[cleanup]", e)), SWEEP_MS);
  console.log("[cleanup] temp-file sweeper started (2h orphan TTL)");
}

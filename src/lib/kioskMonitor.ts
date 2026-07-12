// Kiosk liveness monitor. IoT agents heartbeat every ~30s on the MQTT status
// topic (which updates Printer.lastSeenAt). If a kiosk stops heart-beating —
// power cut, network drop, crash — its MQTT last-will may not fire, so we
// actively mark it OFFLINE once its heartbeat goes stale.
import { prisma } from "./prisma";

const STALE_MS = 90 * 1000; // 3 missed 30s heartbeats
const SWEEP_MS = 30 * 1000;

async function sweep() {
  const cutoff = new Date(Date.now() - STALE_MS);
  const res = await prisma.printer.updateMany({
    where: {
      status: { not: "OFFLINE" },
      OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }],
    },
    data: { status: "OFFLINE" },
  });
  if (res.count) console.log(`[kiosk] marked ${res.count} stale kiosk(s) OFFLINE`);
}

export function startKioskMonitor() {
  setInterval(() => sweep().catch((e) => console.error("[kiosk]", e)), SWEEP_MS);
  console.log("[kiosk] liveness monitor started (90s stale timeout)");
}

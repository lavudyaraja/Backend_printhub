import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import http from "http";
import path from "path";
import { Server } from "socket.io";

import { config } from "./lib/config";
import { authRouter } from "./routes/auth";
import { documentsRouter } from "./routes/documents";
import { ordersRouter } from "./routes/orders";
import { kioskRouter } from "./routes/kiosk";
import { printersRouter } from "./routes/printers";
import { adminRouter } from "./routes/admin";
import { notificationsRouter } from "./routes/notifications";

import { initRealtime } from "./services/realtime";
import { initMqtt } from "./lib/mqtt";
import { handleJobResult } from "./services/printQueue";
import { startCleanup } from "./lib/cleanup";

const app = express();
app.set("trust proxy", 1); // behind Railway/Render/Nginx proxy — needed for rate-limit + secure cookies
app.use(helmet({ contentSecurityPolicy: false })); // CSP off so the admin.html CDN works
app.use(
  cors({
    origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "printhub-backend" }));

// Admin web dashboard (browser only — not part of the mobile app).
app.get(["/admin", "/admin/"], (_req, res) =>
  res.sendFile(path.join(__dirname, "../public/admin.html"))
);

// Throttle auth endpoints to stop brute-force / OTP abuse.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40, // per IP per 15 min across all auth routes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

app.use("/api/auth", authLimiter, authRouter);
app.use("/api/documents", documentsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/kiosk", kioskRouter);
app.use("/api/printers", printersRouter);
app.use("/api/admin", adminRouter);
app.use("/api/notifications", notificationsRouter);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
initRealtime(io);

// MQTT: relay IoT job results back into the print queue.
try {
  initMqtt((payload) => handleJobResult(payload));
} catch (e) {
  console.error("[mqtt] init failed (continuing without IoT)", e);
}

startCleanup();

const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, () => console.log(`[printhub] backend on :${PORT}`));

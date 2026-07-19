import "dotenv/config";
import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { config } from "./lib/config";
import { PAISE_PER_POINT, TOPUP_BONUS_TIERS } from "./lib/points";
import { authRouter } from "./routes/auth";
import { printersRouter } from "./routes/printers";
import { adminRouter } from "./routes/admin";
import { documentsRouter } from "./routes/documents";
import { ordersRouter } from "./routes/orders";
import { pointsRouter } from "./routes/points";
import { vendorsRouter } from "./routes/vendors";
import { notificationsRouter } from "./routes/notifications";
import { complaintsRouter } from "./complaints/router";
import { startCleanup } from "./lib/cleanup";

const app = express();
app.set("trust proxy", 1); // behind Render/Nginx proxy — needed for rate-limit + secure cookies
// This backend serves files (document previews, the checkout logo) that are
// meant to be embedded by *other* origins — Google/Office document viewers and
// the Razorpay checkout page. Helmet's default Cross-Origin-Resource-Policy of
// "same-origin" blocks those cross-origin fetches, leaving previews blank, so we
// relax it to "cross-origin".
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(
  cors({
    origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
  })
);
// JSON body (large enough for base64-free payloads). File uploads use multer per-route.
app.use(express.json({ limit: "2mb" }));

// Public static assets (e.g. logo.png used on the Razorpay checkout page).
app.use(express.static(path.join(process.cwd(), "public"), { maxAge: "7d" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "prinsta-admin-backend" }));

// Public, non-secret settings the clients need to render prices correctly.
// The points rate and bonus tiers are served rather than hardcoded in the app:
// if the two ever disagreed, the user would be shown one price and charged
// another.
app.get("/api/config", (_req, res) =>
  res.json({
    pointsDiscountPercent: config.pointsDiscountPercent,
    paisePerPoint: PAISE_PER_POINT,
    topupBonusTiers: TOPUP_BONUS_TIERS,
    // Old key, kept so already-installed mobile builds keep reading a discount.
    walletDiscountPercent: config.pointsDiscountPercent,
  })
);

// Throttle auth endpoints to stop brute-force abuse.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40, // per IP per 15 min across all auth routes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

app.use("/api/auth", authLimiter, authRouter);
app.use("/api/printers", printersRouter);
app.use("/api/vendors", vendorsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/documents", documentsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/points", pointsRouter);
// Pre-rename path. Installed mobile builds still call /api/wallet, so it stays
// mounted as an alias until those have aged out.
app.use("/api/wallet", pointsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/complaints", complaintsRouter);

startCleanup();

const PORT = config.port;
app.listen(PORT, () => console.log(`[prinsta] backend on :${PORT} · payments ${config.razorpay.configured ? config.razorpay.mode : "disabled"}`));

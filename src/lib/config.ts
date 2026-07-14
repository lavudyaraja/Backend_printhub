// Central config + production env validation. Fail fast on unsafe defaults.
const isProd = process.env.NODE_ENV === "production";

const INSECURE_DEFAULTS: Record<string, string> = {
  JWT_SECRET: "dev_secret",
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    if (isProd) throw new Error(`[config] Missing required env var: ${name}`);
    return "";
  }
  if (isProd && INSECURE_DEFAULTS[name] === v) {
    throw new Error(`[config] ${name} is still the default value — set a strong secret in production.`);
  }
  return v;
}

export const config = {
  isProd,
  port: Number(process.env.PORT || 4000),
  jwtSecret: required("JWT_SECRET") || "dev_secret",
  databaseUrl: required("DATABASE_URL"),
  backendUrl: process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`,
  // Comma-separated allowed origins for CORS (admin dashboard, etc). "*" allows all.
  corsOrigins: (process.env.CORS_ORIGINS || "*").split(",").map((s) => s.trim()),

  // Razorpay — start in TEST mode (rzp_test_… keys). Flip the keys to live later.
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || "",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "",
    get configured() {
      return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
    },
    get mode() {
      return (process.env.RAZORPAY_KEY_ID || "").startsWith("rzp_live_") ? "live" : "test";
    },
  },

  // Upload limits
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024), // 50 MB

  // Paying from the Prinsta wallet is cheaper than paying directly — it saves us
  // the payment-gateway fee, so the saving is passed back to the user.
  walletDiscountPercent: Math.min(100, Math.max(0, Number(process.env.WALLET_DISCOUNT_PERCENT || 10))),
};

/**
 * The URL clients should call us back on, derived from the request that is
 * already reaching us. BACKEND_URL wins when set, but without this the default
 * would be http://localhost:4000 — which resolves to nothing on a user's phone,
 * so the hosted checkout page could never post its payment result back.
 */
export function publicBaseUrl(req: { headers: Record<string, any>; protocol?: string }): string {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL.replace(/\/+$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!host) return config.backendUrl;
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  return `${proto}://${host}`;
}

// Validate at import time so the app refuses to boot with unsafe prod config.
if (isProd) {
  required("JWT_SECRET");
  required("DATABASE_URL");
}

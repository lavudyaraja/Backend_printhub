// Central config + production env validation. Fail fast on unsafe defaults.
const isProd = process.env.NODE_ENV === "production";

const INSECURE_DEFAULTS: Record<string, string> = {
  JWT_SECRET: "dev_secret",
  ADMIN_SIGNUP_CODE: "PRINTHUB-ADMIN-2026",
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
  adminSignupCode: process.env.ADMIN_SIGNUP_CODE || "PRINTHUB-ADMIN-2026",
  databaseUrl: required("DATABASE_URL"),
  mqttUrl: process.env.MQTT_URL || "mqtt://localhost:1883",
  backendUrl: process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`,
  // Comma-separated allowed origins for CORS (admin dashboard, etc). "*" allows all.
  corsOrigins: (process.env.CORS_ORIGINS || "*").split(",").map((s) => s.trim()),
};

// Validate at import time so the app refuses to boot with unsafe prod config.
if (isProd) {
  required("JWT_SECRET");
  required("ADMIN_SIGNUP_CODE");
  required("DATABASE_URL");
}

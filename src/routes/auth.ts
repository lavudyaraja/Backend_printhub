// Auth: mobile-number + password. Register, login, forgot/reset password, OTP login.
// OTP + reset codes are stored in-memory and (in dev) returned in the response.
// For production, send the code via an SMS provider (MSG91/Twilio) instead.
import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/auth";
import { requireAuth, AuthedRequest } from "../middleware/authGuard";
import { sendEmail, otpEmail, welcomeEmail, loginAlertEmail } from "../lib/mailer";

export const authRouter = Router();

const isProd = process.env.NODE_ENV === "production";

// phone -> { code, expires }
const resetCodes = new Map<string, { code: string; expires: number }>();

const phone = z
  .string()
  .transform((p) => p.replace(/\D/g, ""))
  .refine((p) => p.length === 10, "Enter a valid 10-digit mobile number");
const password = z.string().min(6, "Password must be at least 6 characters");
const emailOpt = z
  .string()
  .email("Enter a valid email")
  .optional()
  .or(z.literal(""))
  .transform((e) => (e ? e.trim().toLowerCase() : undefined));

function newCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function safeUser(u: any) {
  const { passwordHash, ...rest } = u;
  return rest;
}
function firstError(err: z.ZodError) {
  return err.errors[0]?.message || "Invalid input";
}

// ── Register ───────────────────────────────────────────────────────
const registerSchema = z.object({
  name: z.string().min(2, "Enter your full name"),
  phone,
  email: emailOpt,
  password,
  rollNumber: z.string().optional(),
  // Play Store compliance: user must accept Privacy Policy + Terms at signup.
  consent: z.boolean().optional(),
});

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: firstError(parsed.error) });
  const { name, phone: ph, email, password: pw, rollNumber, consent } = parsed.data;

  if (consent === false) {
    return res.status(400).json({ error: "You must accept the Privacy Policy and Terms of Service" });
  }

  const existing = await prisma.user.findUnique({ where: { phone: ph } });
  if (existing) return res.status(409).json({ error: "This mobile number is already registered" });

  const passwordHash = await bcrypt.hash(pw, 10);
  const user = await prisma.user.create({
    data: { name, phone: ph, email: email || null, passwordHash, rollNumber: rollNumber || null },
  });

  // Welcome email (best-effort — never blocks signup; no-op if Brevo unset).
  if (user.email) {
    const { subject, html } = welcomeEmail(user.name);
    sendEmail(user.email, subject, html);
  }

  const token = signToken({ userId: user.id, role: user.role });
  res.json({ token, user: safeUser(user) });
});

// ── Register admin/operator (requires the admin signup code) ───────
const ADMIN_CODE = process.env.ADMIN_SIGNUP_CODE || "PRINTHUB-ADMIN-2026";
const adminRegisterSchema = z.object({
  name: z.string().min(2, "Enter your full name"),
  phone,
  email: emailOpt,
  password,
  adminCode: z.string(),
});

authRouter.post("/register-admin", async (req, res) => {
  const parsed = adminRegisterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: firstError(parsed.error) });
  const { name, phone: ph, email, password: pw, adminCode } = parsed.data;

  if (adminCode !== ADMIN_CODE) {
    return res.status(403).json({ error: "Invalid admin signup code" });
  }
  const existing = await prisma.user.findUnique({ where: { phone: ph } });
  if (existing) return res.status(409).json({ error: "This mobile number is already registered" });

  const passwordHash = await bcrypt.hash(pw, 10);
  const user = await prisma.user.create({
    data: { name, phone: ph, email: email || null, passwordHash, role: "ADMIN" },
  });
  const token = signToken({ userId: user.id, role: user.role });
  res.json({ token, user: safeUser(user) });
});

// ── Login (phone + password) ───────────────────────────────────────
authRouter.post("/login", async (req, res) => {
  const parsed = z.object({ phone, password: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid mobile number or password" });
  const { phone: ph, password: pw } = parsed.data;

  const user = await prisma.user.findUnique({ where: { phone: ph } });
  if (!user || !user.passwordHash) {
    return res.status(401).json({ error: "Invalid mobile number or password" });
  }
  const ok = await bcrypt.compare(pw, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid mobile number or password" });

  // Login-alert email (best-effort — never blocks login; no-op if Brevo unset).
  if (user.email) {
    const { subject, html } = loginAlertEmail(user.name);
    sendEmail(user.email, subject, html);
  }

  const token = signToken({ userId: user.id, role: user.role });
  res.json({ token, user: safeUser(user) });
});

// ── Forgot password: request reset code ────────────────────────────
authRouter.post("/forgot-password", async (req, res) => {
  const parsed = z.object({ phone }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: firstError(parsed.error) });
  const ph = parsed.data.phone;

  const user = await prisma.user.findUnique({ where: { phone: ph } });
  const code = newCode();
  let delivered = false;
  if (user) {
    resetCodes.set(ph, { code, expires: Date.now() + 10 * 60 * 1000 });
    if (user.email) {
      const { subject, html } = otpEmail(code, "reset");
      delivered = await sendEmail(user.email, subject, html);
    }
  }
  res.json({
    sent: true,
    message: "If an account exists, a reset code has been sent.",
    // Dev-only convenience: reveal the code when no real SMS provider is set.
    devCode: delivered || isProd ? undefined : user ? code : undefined,
  });
});

// ── Reset password: verify code + set new password ─────────────────
authRouter.post("/reset-password", async (req, res) => {
  const parsed = z.object({ phone, code: z.string().length(6), password }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: firstError(parsed.error) });
  const { phone: ph, code, password: pw } = parsed.data;

  const entry = resetCodes.get(ph);
  if (!entry || entry.expires < Date.now() || entry.code !== code) {
    return res.status(400).json({ error: "Invalid or expired reset code" });
  }
  const passwordHash = await bcrypt.hash(pw, 10);
  const user = await prisma.user.update({ where: { phone: ph }, data: { passwordHash } });
  resetCodes.delete(ph);

  const token = signToken({ userId: user.id, role: user.role });
  res.json({ token, user: safeUser(user) });
});

// ── Current user ───────────────────────────────────────────────────
authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  res.json({ user: user ? safeUser(user) : null });
});

// ── Update profile (name, email, roll number) ──────────────────────
const updateSchema = z.object({
  name: z.string().min(2).optional(),
  email: emailOpt,
  rollNumber: z.string().optional(),
});

authRouter.patch("/me", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: firstError(parsed.error) });
  const { name, email, rollNumber } = parsed.data;
  try {
    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(email !== undefined ? { email: email || null } : {}),
        ...(rollNumber !== undefined ? { rollNumber: rollNumber || null } : {}),
      },
    });
    res.json({ user: safeUser(user) });
  } catch (e: any) {
    if (e.code === "P2002") return res.status(409).json({ error: "Email or roll number already in use" });
    res.status(500).json({ error: "Could not update profile" });
  }
});

// ── Delete account + all associated data (Play Store data-deletion) ─
// Cascades to the user's documents, orders, print jobs and notifications
// via the onDelete: Cascade relations in the Prisma schema.
authRouter.delete("/me", requireAuth, async (req: AuthedRequest, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : undefined;
  try {
    await prisma.user.delete({ where: { id: req.user!.userId } });
    console.log(`[account-deletion] user ${req.user!.userId} deleted${reason ? ` — reason: ${reason}` : ""}`);
    res.json({ deleted: true });
  } catch (e: any) {
    if (e.code === "P2025") return res.status(404).json({ error: "Account not found" });
    console.error("[account-deletion] failed", e);
    res.status(500).json({ error: "Could not delete account. Please email support." });
  }
});

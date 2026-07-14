import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/auth";
import { requireAuth, AuthedRequest } from "../middleware/authGuard";
import { sendEmail, otpEmail, welcomeEmail, loginAlertEmail } from "../lib/mailer";

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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

// ── Register admin (email + password; no phone or code required) ───
const adminRegisterSchema = z.object({
  name: z.string().min(2, "Enter your full name"),
  email: z.string().email("Enter a valid email").transform((e) => e.trim().toLowerCase()),
  password,
});

authRouter.post("/register-admin", async (req, res) => {
  const parsed = adminRegisterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: firstError(parsed.error) });
  const { name, email, password: pw } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "This email is already registered" });

  const passwordHash = await bcrypt.hash(pw, 10);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role: "ADMIN" },
  });
  const token = signToken({ userId: user.id, role: user.role });
  res.json({ token, user: safeUser(user) });
});

// ── Google OAuth login / register (admin console) ──────────────────
// The frontend uses useGoogleLogin (access-token flow), fetches userInfo
// from Google's userinfo endpoint, and sends both here. We re-verify the
// access token against Google's tokeninfo endpoint before trusting the payload.
authRouter.post("/google", async (req, res) => {
  const { credential, userInfo } = req.body;
  if (!credential || !userInfo?.email) {
    return res.status(400).json({ error: "Missing Google credential or user info" });
  }

  try {
    // Verify the access token is valid and belongs to our app
    const tokenCheck = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${credential}`
    );
    if (!tokenCheck.ok) {
      return res.status(401).json({ error: "Invalid Google access token" });
    }
    const tokenData = await tokenCheck.json() as { email?: string; sub?: string };

    const email = (tokenData.email || userInfo.email).toLowerCase();
    const googleId = tokenData.sub || userInfo.sub;
    const name = userInfo.name || email.split("@")[0];

    if (!googleId) return res.status(400).json({ error: "Could not verify Google identity" });

    let user = await prisma.user.findFirst({
      where: { OR: [{ googleId }, { email }] },
    });

    if (user) {
      if (!user.googleId) {
        user = await prisma.user.update({ where: { id: user.id }, data: { googleId } });
      }
      if (user.role !== "ADMIN" && user.role !== "OPERATOR") {
        return res.status(403).json({ error: "Access denied. An admin account is required." });
      }
    } else {
      // First Google sign-in → create admin account automatically
      user = await prisma.user.create({
        data: { name, email, googleId, role: "ADMIN" },
      });
    }

    const token = signToken({ userId: user.id, role: user.role });
    res.json({ token, user: safeUser(user) });
  } catch (e: any) {
    console.error("[google-auth]", e.message);
    res.status(401).json({ error: "Google authentication failed" });
  }
});

// ── Login (phone OR email + password) ──────────────────────────────
// Mobile app signs in with `phone`; the admin console signs in with
// `email`. Either identifier is accepted so both clients share this route.
const loginSchema = z
  .object({
    phone: z.string().optional(),
    email: z.string().optional(),
    password: z.string().min(1),
  })
  .refine((d) => !!(d.phone || d.email), "Enter your mobile number or email");

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid credentials" });
  const { phone: rawPhone, email: rawEmail, password: pw } = parsed.data;

  // Look up by whichever identifier was supplied.
  let user = null;
  if (rawPhone) {
    const ph = rawPhone.replace(/\D/g, "");
    user = await prisma.user.findUnique({ where: { phone: ph } });
  } else if (rawEmail) {
    const em = rawEmail.trim().toLowerCase();
    user = await prisma.user.findUnique({ where: { email: em } });
  }

  if (!user || !user.passwordHash) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const ok = await bcrypt.compare(pw, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid mobile number or password" });

  // Login-alert email (best-effort — never blocks login; no-op if Brevo unset).
  if (user.email && user.emailNotifications) {
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
  emailNotifications: z.boolean().optional(),
});

authRouter.patch("/me", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: firstError(parsed.error) });
  const { name, email, rollNumber, emailNotifications } = parsed.data;
  try {
    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(email !== undefined ? { email: email || null } : {}),
        ...(rollNumber !== undefined ? { rollNumber: rollNumber || null } : {}),
        ...(emailNotifications !== undefined ? { emailNotifications } : {}),
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

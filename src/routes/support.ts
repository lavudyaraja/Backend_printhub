// Support / privacy contact channel for the mobile "Contact Us" screen.
// Records the request server-side. For production, forward `message` to your
// support inbox (e.g. via nodemailer / an email API) where the TODO is marked.
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthedRequest } from "../middleware/authGuard";

export const supportRouter = Router();

const contactSchema = z.object({
  subject: z.string().min(3, "Please enter a subject").max(120),
  message: z.string().min(10, "Please describe your request").max(4000),
});

supportRouter.post("/contact", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
  }
  const { subject, message } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  console.log(
    `[support] from ${user?.name} <${user?.email || user?.phone}> (${req.user!.userId})\n` +
      `  subject: ${subject}\n  message: ${message}`
  );
  // TODO: forward to support inbox (email/ticketing) for a production deployment.

  res.json({ received: true });
});

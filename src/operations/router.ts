// Operations: the queues an operator works rather than the records they browse.
//
// Print Queue, Printer Health, Verifications, Disputes and Support. ADMIN only —
// these are platform-wide views and several of them take actions (retrying a
// job, verifying a bank account) that a shop owner must not be able to perform
// on someone else's rows.
//
// Where a section has no table behind it, there is no endpoint here and the
// console says so — an empty array would be read as "nothing to do".
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/authGuard";

export const operationsRouter = Router();
operationsRouter.use(requireAuth, requireRole("ADMIN"));

/** Paper/toner at or below this warrants an alert. */
const LOW = 20;

// ── Print Queue ──────────────────────────────────────────────────────────────
//
// Backed by PrintJob, which is a real record: status, attempt count, the error
// text from the last failure, and start/finish stamps.
operationsRouter.get("/print-queue", async (req, res) => {
  const { status } = req.query as Record<string, string>;

  const where: any = {};
  if (status) where.status = status;

  const [jobs, byStatus] = await Promise.all([
    prisma.printJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, status: true, attempts: true, error: true,
        startedAt: true, finishedAt: true, createdAt: true, updatedAt: true,
        printer: { select: { id: true, name: true, uniquePrinterId: true, shopName: true, status: true } },
        order: {
          select: {
            id: true, orderCode: true, status: true, costPaise: true, pagesToPrint: true,
            user: { select: { id: true, name: true, phone: true } },
            document: { select: { fileName: true } },
          },
        },
      },
    }),
    prisma.printJob.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const countFor = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;

  res.json({
    total: byStatus.reduce((sum, r) => sum + r._count._all, 0),
    queued: countFor("QUEUED"),
    sent: countFor("SENT"),
    printing: countFor("PRINTING"),
    done: countFor("DONE"),
    error: countFor("ERROR"),
    jobs,
  });
});

/**
 * Put a failed job back in the queue.
 *
 * Only from ERROR: requeuing a job that is mid-flight would have the printer
 * run it twice. The attempt count is left alone — it is the record of how many
 * times this has been tried, and resetting it would hide a job that keeps
 * failing.
 */
operationsRouter.post("/print-queue/:id/retry", async (req: AuthedRequest, res) => {
  const job = await prisma.printJob.findUnique({
    where: { id: req.params.id },
    select: { id: true, status: true },
  });
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "ERROR") {
    return res.status(409).json({
      error: `Only failed jobs can be retried. This one is ${job.status}.`,
    });
  }

  const updated = await prisma.printJob.update({
    where: { id: job.id },
    data: { status: "QUEUED", error: null, startedAt: null, finishedAt: null },
  });
  res.json({ job: updated });
});

// ── Printer Health ───────────────────────────────────────────────────────────
operationsRouter.get("/printer-health", async (_req, res) => {
  const [printers, ordersByPrinter, completedByPrinter, failedByPrinter, jobErrors] =
    await Promise.all([
      prisma.printer.findMany({
        orderBy: { shopName: "asc" },
        select: {
          id: true, name: true, uniquePrinterId: true, shopName: true, locationName: true,
          brand: true, model: true, status: true, paperLevel: true, tonerLevel: true,
          lastSeenAt: true, createdAt: true, verifiedAt: true, rejectedAt: true,
        },
      }),
      prisma.order.groupBy({ by: ["printerId"], _count: { _all: true } }),
      prisma.order.groupBy({
        by: ["printerId"],
        where: { status: "COMPLETED" },
        _count: { _all: true },
        _sum: { pagesToPrint: true, costPaise: true },
      }),
      prisma.order.groupBy({ by: ["printerId"], where: { status: "FAILED" }, _count: { _all: true } }),
      // The closest thing to an error log that exists: jobs currently in ERROR,
      // with the text the printer reported.
      prisma.printJob.findMany({
        where: { status: "ERROR" },
        orderBy: { updatedAt: "desc" },
        take: 100,
        select: {
          id: true, error: true, attempts: true, updatedAt: true,
          printer: { select: { id: true, name: true, uniquePrinterId: true } },
          order: { select: { orderCode: true } },
        },
      }),
    ]);

  const orders = new Map(ordersByPrinter.map((r) => [r.printerId, r._count._all]));
  const completed = new Map(completedByPrinter.map((r) => [r.printerId, r]));
  const failed = new Map(failedByPrinter.map((r) => [r.printerId, r._count._all]));

  const rows = printers.map((p) => {
    const total = orders.get(p.id) || 0;
    const done = completed.get(p.id)?._count._all || 0;
    const fail = failed.get(p.id) || 0;
    const issues: string[] = [];
    if (p.status === "ERROR") issues.push("Error state");
    if (p.status === "OUT_OF_PAPER") issues.push("Out of paper");
    if (p.status === "OFFLINE") issues.push("Offline");
    if (p.paperLevel <= LOW) issues.push("Low paper");
    if (p.tonerLevel <= LOW) issues.push("Low toner");

    return {
      ...p,
      orders: total,
      completedOrders: done,
      failedOrders: fail,
      pagesPrinted: completed.get(p.id)?._sum.pagesToPrint || 0,
      revenuePaise: completed.get(p.id)?._sum.costPaise || 0,
      // Share of this machine's jobs that finished. The number to judge a
      // printer on — a busy machine that fails a third of its jobs is worse
      // than a quiet one that never does.
      successRate: total > 0 ? Math.round((done / total) * 100) : null,
      lowPaper: p.paperLevel <= LOW,
      lowToner: p.tonerLevel <= LOW,
      issues,
      healthy: issues.length === 0,
    };
  });

  res.json({
    total: rows.length,
    online: rows.filter((p) => p.status === "ONLINE").length,
    offline: rows.filter((p) => p.status === "OFFLINE").length,
    lowPaper: rows.filter((p) => p.lowPaper).length,
    lowToner: rows.filter((p) => p.lowToner).length,
    errored: rows.filter((p) => p.status === "ERROR").length,
    healthy: rows.filter((p) => p.healthy).length,
    lowThreshold: LOW,
    printers: rows,
    // Current failures only — nothing keeps a history of resolved errors.
    errorLog: jobErrors,
  });
});

// ── Verifications ────────────────────────────────────────────────────────────
operationsRouter.get("/verifications", async (_req, res) => {
  const [banks, vendors, printers] = await Promise.all([
    prisma.bankAccount.findMany({
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: {
        id: true, accountHolder: true, accountNumber: true, ifsc: true,
        bankName: true, upiId: true, verified: true, updatedAt: true,
        user: {
          select: {
            id: true, name: true, phone: true, email: true, role: true,
            vendor: { select: { id: true, shopName: true } },
          },
        },
      },
    }),
    prisma.vendor.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, shopName: true, contactName: true, mobileNumber: true,
        verifiedAt: true, rejectedAt: true, verificationNote: true, createdAt: true,
        // KYC the shop submitted, for the reviewer to check against.
        legalName: true, panNumber: true, aadhaarNumber: true, gstin: true, kycSubmittedAt: true,
        user: { select: { id: true, name: true, email: true, bankAccount: { select: { accountHolder: true, ifsc: true, bankName: true, verified: true } } } },
        _count: { select: { printers: true, orders: true } },
      },
    }),
    prisma.printer.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, name: true, uniquePrinterId: true, shopName: true, locationName: true,
        brand: true, model: true, serialNumber: true, ipAddress: true,
        verifiedAt: true, rejectedAt: true, verificationNote: true, createdAt: true,
        vendor: { select: { id: true, shopName: true } },
      },
    }),
  ]);

  res.json({
    bank: {
      total: banks.length,
      verified: banks.filter((b) => b.verified).length,
      pending: banks.filter((b) => !b.verified).length,
      items: banks.map(({ accountNumber, ...b }) => ({
        ...b,
        accountMasked: `••••••${accountNumber.slice(-4)}`,
      })),
    },
    shop: {
      total: vendors.length,
      verified: vendors.filter((v) => v.verifiedAt).length,
      rejected: vendors.filter((v) => v.rejectedAt).length,
      pending: vendors.filter((v) => !v.verifiedAt && !v.rejectedAt).length,
      items: vendors,
    },
    printer: {
      total: printers.length,
      verified: printers.filter((p) => p.verifiedAt).length,
      rejected: printers.filter((p) => p.rejectedAt).length,
      pending: printers.filter((p) => !p.verifiedAt && !p.rejectedAt).length,
      items: printers,
    },
  });
});

const decisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(1000).optional(),
});

/** Approve or reject a shop. */
operationsRouter.patch("/verifications/shop/:id", async (req: AuthedRequest, res) => {
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid decision" });
  const approve = parsed.data.decision === "APPROVE";

  const vendor = await prisma.vendor.update({
    where: { id: req.params.id },
    // Only one of the two stamps is ever set, so a record can't read as both
    // approved and rejected.
    data: {
      verifiedAt: approve ? new Date() : null,
      rejectedAt: approve ? null : new Date(),
      verifiedById: req.user!.userId,
      verificationNote: parsed.data.note || null,
    },
    select: { id: true, shopName: true, verifiedAt: true, rejectedAt: true, userId: true },
  });

  // Tell the shop the KYC outcome — this is what lands in their console's bell.
  await prisma.notification
    .create({
      data: {
        userId: vendor.userId,
        title: approve ? "KYC approved — you're verified" : "KYC needs attention",
        body: approve
          ? "Your shop has been verified. You're all set to take orders and receive payouts."
          : `Your KYC was not approved${parsed.data.note ? `: ${parsed.data.note}` : "."} Please review your details and resubmit.`,
        link: "/vendor/kyc",
      },
    })
    .catch(() => {});

  res.json({ vendor });
});

/** Approve or reject a printer. */
operationsRouter.patch("/verifications/printer/:id", async (req: AuthedRequest, res) => {
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid decision" });
  const approve = parsed.data.decision === "APPROVE";

  const printer = await prisma.printer.update({
    where: { id: req.params.id },
    data: {
      verifiedAt: approve ? new Date() : null,
      rejectedAt: approve ? null : new Date(),
      verifiedById: req.user!.userId,
      verificationNote: parsed.data.note || null,
    },
    select: { id: true, name: true, verifiedAt: true, rejectedAt: true },
  });
  res.json({ printer });
});

/**
 * Mark a payout account verified.
 *
 * The flag means "a human checked this", not "a penny drop succeeded" — nothing
 * here talks to a bank. Editing the account clears the flag again (see the
 * bank-account route), so it can't stay verified for details that have changed.
 */
operationsRouter.patch("/verifications/bank/:id", async (req, res) => {
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid decision" });

  const account = await prisma.bankAccount.update({
    where: { id: req.params.id },
    data: { verified: parsed.data.decision === "APPROVE" },
    select: { id: true, accountHolder: true, verified: true },
  });
  res.json({ account });
});

// ── Support ──────────────────────────────────────────────────────────────────
// Tickets split by who raised them, which is the split the console asks for
// (user queries vs vendor queries) and is derivable from the author's role.
operationsRouter.get("/support", async (req, res) => {
  const { status, audience } = req.query as Record<string, string>;

  const where: any = {};
  if (status) where.status = status;
  if (audience === "USER") where.user = { role: "STUDENT" };
  if (audience === "VENDOR") where.user = { role: { in: ["VENDOR", "OPERATOR"] } };

  const [tickets, byStatus] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, name: true, email: true, subject: true, message: true,
        status: true, reply: true, createdAt: true, updatedAt: true, userId: true,
      },
    }),
    prisma.supportTicket.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  // The author's role is what makes a ticket a "user query" or a "vendor
  // query"; the ticket row itself only stores a name and an email.
  const authorIds = tickets.map((t) => t.userId).filter(Boolean) as string[];
  const authors = await prisma.user.findMany({
    where: { id: { in: authorIds } },
    select: { id: true, role: true, name: true, phone: true },
  });
  const roleOf = new Map(authors.map((a) => [a.id, a]));

  const countFor = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;

  res.json({
    total: byStatus.reduce((sum, r) => sum + r._count._all, 0),
    open: countFor("OPEN"),
    inProgress: countFor("IN_PROGRESS"),
    resolved: countFor("RESOLVED"),
    closed: countFor("CLOSED"),
    tickets: tickets.map((t) => {
      const author = t.userId ? roleOf.get(t.userId) : null;
      return {
        ...t,
        authorRole: author?.role || null,
        // A ticket raised from a signed-out contact form has no author, so it
        // can't be attributed to either audience.
        audience: !author
          ? "UNKNOWN"
          : author.role === "STUDENT"
            ? "USER"
            : ["VENDOR", "OPERATOR"].includes(author.role)
              ? "VENDOR"
              : "STAFF",
      };
    }),
  });
});

/** Reply to a ticket and/or move its status. */
operationsRouter.patch("/support/:id", async (req, res) => {
  const parsed = z
    .object({
      status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
      reply: z.string().trim().max(4000).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid update" });

  const existing = await prisma.supportTicket.findUnique({
    where: { id: req.params.id },
    select: { id: true, userId: true, subject: true },
  });
  if (!existing) return res.status(404).json({ error: "Ticket not found" });

  const ticket = await prisma.supportTicket.update({
    where: { id: existing.id },
    data: {
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.reply !== undefined ? { reply: parsed.data.reply } : {}),
    },
  });

  // Tell the author there's an answer waiting, when there is one and we know
  // who they are.
  if (parsed.data.reply?.trim() && existing.userId) {
    await prisma.notification.create({
      data: {
        userId: existing.userId,
        title: "Support replied",
        body: `We've replied to "${existing.subject}". Open the app to read it.`,
      },
    });
  }

  res.json({ ticket });
});

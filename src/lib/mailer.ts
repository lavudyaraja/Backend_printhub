// Transactional email via Brevo (free plan) — dependency-free, uses the global
// fetch (Node 18+). If BREVO_API_KEY is not set, every send is a no-op that just
// logs to the console (development behaviour) and returns false, so callers can
// still surface a devCode. Sends are best-effort and never throw into callers.
//
// Env:
//   BREVO_API_KEY   your Brevo v3 API key (starts with "xkeysib-")
//   MAIL_FROM       sender, e.g. "PrintHub <no-reply@yourdomain.com>"

function parseFrom(): { email: string; name: string } {
  const raw = process.env.MAIL_FROM || "PrintHub <no-reply@printhub.app>";
  const m = raw.match(/^(.*?)\s*<(.+?)>$/);
  return m ? { name: m[1].trim() || "PrintHub", email: m[2].trim() } : { name: "PrintHub", email: raw.trim() };
}

export function mailConfigured() {
  return !!process.env.BREVO_API_KEY;
}

/** Send an HTML email through Brevo. Returns true only if Brevo accepted it. */
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!to) return false;
  if (!mailConfigured()) {
    console.log(`[mail:dev] to=${to} subject="${subject}" (Brevo not configured)`);
    return false;
  }
  try {
    const from = parseFrom();
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY!, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: from, to: [{ email: to }], subject, htmlContent: html }),
    });
    if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
    console.log(`[mail:brevo] sent "${subject}" to ${to}`);
    return true;
  } catch (e) {
    console.error("[mail:brevo] failed", e);
    return false;
  }
}

// ── Templates ──────────────────────────────────────────────────────
const BRAND = "#6D4AFF";

function shell(inner: string) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#F5F4FB;padding:24px">
  <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #ECECF1">
    <div style="background:${BRAND};padding:20px 24px"><span style="color:#fff;font-size:20px;font-weight:800">PrintHub</span></div>
    <div style="padding:24px">${inner}</div>
    <div style="padding:16px 24px;border-top:1px solid #F0F0F4;color:#9090A0;font-size:12px">
      You received this email from PrintHub. If this wasn't you, please ignore it.
    </div>
  </div>
</div>`;
}

export function otpEmail(code: string, purpose: "login" | "reset" = "login") {
  const heading = purpose === "reset" ? "Reset your password" : "Your login code";
  const mins = purpose === "reset" ? "10" : "5";
  const html = shell(`
    <h2 style="margin:0 0 8px;color:#111114;font-size:20px">${heading}</h2>
    <p style="color:#4A4A5A;font-size:14px;line-height:21px;margin:0 0 18px">Use this one-time code to continue. It expires in ${mins} minutes.</p>
    <div style="background:#F5F4FB;border-radius:12px;text-align:center;padding:18px;font-size:30px;font-weight:800;letter-spacing:8px;color:${BRAND}">${code}</div>
    <p style="color:#9090A0;font-size:12px;margin:18px 0 0">Never share this code with anyone. PrintHub will never ask for it.</p>`);
  return { subject: `${code} is your PrintHub ${purpose === "reset" ? "password reset" : "login"} code`, html };
}

export function loginAlertEmail(name: string) {
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  const html = shell(`
    <h2 style="margin:0 0 8px;color:#111114;font-size:20px">You logged in to PrintHub</h2>
    <p style="color:#4A4A5A;font-size:14px;line-height:21px;margin:0 0 12px">Hi ${name}, your PrintHub account was just signed in.</p>
    <div style="background:#F5F4FB;border-radius:12px;padding:14px;color:#4A4A5A;font-size:13px">Time: <b>${when} IST</b></div>
    <p style="color:#9090A0;font-size:12px;margin:16px 0 0">If this was you, no action is needed. If you didn't sign in, please reset your password immediately.</p>`);
  return { subject: "New login to your PrintHub account", html };
}

export function welcomeEmail(name: string) {
  const html = shell(`
    <h2 style="margin:0 0 8px;color:#111114;font-size:20px">Welcome, ${name}! 🎉</h2>
    <p style="color:#4A4A5A;font-size:14px;line-height:21px">Your PrintHub account is ready. Upload a document, choose your print options, and collect your prints at any kiosk.</p>`);
  return { subject: "Welcome to PrintHub", html };
}

export function orderReceiptEmail(opts: {
  name: string; orderCode: string; pages: number; copies: number; colorMode: string; amountPaise: number;
}) {
  const amount = (opts.amountPaise / 100).toFixed(2);
  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 0;color:#9090A0;font-size:13px">${k}</td><td style="padding:6px 0;color:#111114;font-size:13px;font-weight:600;text-align:right">${v}</td></tr>`;
  const html = shell(`
    <h2 style="margin:0 0 8px;color:#111114;font-size:20px">Order confirmed ✅</h2>
    <p style="color:#4A4A5A;font-size:14px;line-height:21px;margin:0 0 16px">Hi ${opts.name}, your order <b>#${opts.orderCode}</b> is confirmed.</p>
    <table style="width:100%;border-collapse:collapse">
      ${row("Order", "#" + opts.orderCode)}
      ${row("Pages", String(opts.pages))}
      ${row("Copies", String(opts.copies))}
      ${row("Colour", opts.colorMode === "COLOR" ? "Colour" : "Black & White")}
      ${row("Amount", "₹" + amount)}
    </table>
    <p style="color:#9090A0;font-size:12px;margin:18px 0 0">Scan your QR at any kiosk to collect your prints.</p>`);
  return { subject: `Order #${opts.orderCode} confirmed — PrintHub`, html };
}

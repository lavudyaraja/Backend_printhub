// Single-use sessions for the hosted Razorpay checkout page.
//
// The checkout page runs inside the app's WebView and has to prove who it is
// when it posts the payment result back. It used to carry the user's 30-day JWT
// in the page URL, which put a full-access credential into the server's access
// logs, any proxy in between, and the WebView's own history.
//
// A session id replaces it: minted by an authenticated request, scoped to one
// Razorpay order, expires in minutes, and is consumed the first time it is
// redeemed. Leaking one costs at most the ability to re-verify a payment that
// has already been made.
import crypto from "crypto";

/** Long enough to finish a UPI/card payment, short enough to be worthless later. */
const TTL_MS = 20 * 60 * 1000;

export interface CheckoutSession {
  userId: string;
  razorpayOrderId: string;
  expiresAt: number;
}

// In-memory on purpose: the backend runs as a single instance, and a session
// that doesn't survive a restart just sends the user back to the payment screen.
// Move to Redis/Postgres before running more than one instance.
const sessions = new Map<string, CheckoutSession>();

function sweepExpired(now: number): void {
  for (const [id, s] of sessions) {
    if (s.expiresAt <= now) sessions.delete(id);
  }
}

export function createCheckoutSession(userId: string, razorpayOrderId: string): string {
  const now = Date.now();
  sweepExpired(now);
  const id = crypto.randomBytes(32).toString("base64url");
  sessions.set(id, { userId, razorpayOrderId, expiresAt: now + TTL_MS });
  return id;
}

/** Look the session up without spending it — used to render the checkout page. */
export function peekCheckoutSession(id: unknown): CheckoutSession | null {
  if (typeof id !== "string" || !id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return s;
}

/** Redeem the session. Returns null if it is unknown, expired or already used. */
export function consumeCheckoutSession(id: unknown): CheckoutSession | null {
  const s = peekCheckoutSession(id);
  if (s) sessions.delete(id as string);
  return s;
}

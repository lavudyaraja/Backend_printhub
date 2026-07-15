// Razorpay integration — orders + signature verification + a hosted checkout
// page (rendered by us, opened inside the mobile app's WebView).
// Runs in TEST mode until live rzp_ keys are set. See config.razorpay.
import crypto from "crypto";
import Razorpay from "razorpay";
import { config } from "./config";

let _client: Razorpay | null = null;
function client(): Razorpay {
  if (!config.razorpay.configured) {
    throw Object.assign(new Error("Payments are not configured on the server."), { code: "RAZORPAY_NOT_CONFIGURED" });
  }
  if (!_client) {
    _client = new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
  }
  return _client;
}

export interface RzOrder {
  id: string;
  amount: number;
  currency: string;
}

/** Create a Razorpay order for the given amount (paise). */
export async function createRazorpayOrder(amountPaise: number, receipt: string, notes?: Record<string, string>): Promise<RzOrder> {
  const order = await client().orders.create({
    amount: amountPaise,
    currency: "INR",
    receipt,
    notes,
  });
  return { id: order.id, amount: Number(order.amount), currency: order.currency };
}

/** Fetch a Razorpay order (authoritative amount). */
export async function fetchRazorpayOrder(orderId: string): Promise<RzOrder> {
  const order = await client().orders.fetch(orderId);
  return { id: order.id, amount: Number(order.amount), currency: order.currency };
}

/** Verify the checkout signature: HMAC_SHA256(order_id|payment_id, key_secret). */
export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
  const expected = crypto
    .createHmac("sha256", config.razorpay.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Verify a Razorpay webhook signature. */
export function verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * HTML for the hosted checkout page shown inside the app WebView.
 * On success it POSTs to `verifyPath` (with the Bearer token) and then
 * postMessages the result back to React Native.
 */
export function checkoutPage(opts: {
  razorpayOrderId: string;
  amountPaise: number;
  name: string;
  description: string;
  verifyPath: string; // absolute URL to POST the payment result to
  token: string;
  image?: string; // logo shown in the Razorpay checkout (replaces the "P" avatar)
  prefillContact?: string;
  prefillEmail?: string;
  extra?: Record<string, string>;
}): string {
  const data = JSON.stringify({
    key: config.razorpay.keyId,
    order_id: opts.razorpayOrderId,
    amount: opts.amountPaise,
    name: opts.name,
    description: opts.description,
    image: opts.image || "",
    verifyUrl: opts.verifyPath,
    token: opts.token,
    prefillContact: opts.prefillContact || "",
    prefillEmail: opts.prefillEmail || "",
    extra: opts.extra || {},
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>Prinsta Payment</title>
<style>
  html,body{height:100%;margin:0;background:#0B0E17;color:#fff;font-family:-apple-system,Roboto,Segoe UI,sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
  .spinner{width:36px;height:36px;border:3px solid rgba(255,255,255,.2);border-top-color:#6D4AFF;border-radius:50%;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .msg{font-size:14px;color:#aab}
</style>
</head>
<body>
<div class="wrap"><div class="spinner"></div><div class="msg">Opening secure payment…</div></div>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
(function(){
  var cfg = ${data};
  function post(obj){
    var s = JSON.stringify(obj);
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) window.ReactNativeWebView.postMessage(s);
  }
  function verify(resp){
    fetch(cfg.verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.token },
      body: JSON.stringify(Object.assign({}, resp, cfg.extra))
    })
    .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
    .then(function(res){
      if (res.ok && res.d && res.d.ok) post({ status: "success", data: res.d });
      else post({ status: "failed", message: (res.d && res.d.error) || "Verification failed" });
    })
    .catch(function(){ post({ status: "failed", message: "Network error during verification" }); });
  }
  var options = {
    key: cfg.key,
    order_id: cfg.order_id,
    amount: cfg.amount,
    currency: "INR",
    name: cfg.name,
    description: cfg.description,
    image: cfg.image || undefined,
    prefill: { contact: cfg.prefillContact, email: cfg.prefillEmail },
    theme: { color: "#6D4AFF" },
    // Only offer methods that complete in-page ("handler mode"). Netbanking,
    // wallets and pay-later use a full-page redirect that navigates the WebView
    // away from this page, destroying the verify script → "network error during
    // verification". Restricting to UPI + card keeps the whole flow in one page.
    method: { upi: true, card: true, netbanking: false, wallet: false, paylater: false, emi: false },
    handler: function(response){ verify(response); },
    modal: { ondismiss: function(){ post({ status: "cancelled" }); } }
  };
  try { var rzp = new Razorpay(options); rzp.on("payment.failed", function(r){ post({ status:"failed", message: (r.error && r.error.description) || "Payment failed" }); }); rzp.open(); }
  catch(e){ post({ status: "failed", message: String(e) }); }
})();
</script>
</body>
</html>`;
}

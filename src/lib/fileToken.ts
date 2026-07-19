// Short-lived, document-scoped access tokens for the raw-file endpoint.
//
// React Native's <Image>, FileSystem.downloadAsync and the WebView document
// viewers all fetch a URL directly and cannot attach an Authorization header.
// The endpoint therefore used to be fully public, with the cuid acting as the
// only secret — which meant a leaked or logged URL granted permanent access to
// someone's document.
//
// A token pins access to one document and expires quickly, so a URL that escapes
// (a proxy log, a viewer's referrer, a screenshot) stops working within minutes.
import crypto from "crypto";
import { config } from "./config";

/** Long enough to upload, configure and pay; short enough that a leak goes stale. */
export const FILE_TOKEN_TTL_MS = 30 * 60 * 1000;

function sign(documentId: string, exp: number): string {
  return crypto
    .createHmac("sha256", config.jwtSecret)
    .update(`${documentId}.${exp}`)
    .digest("base64url");
}

export interface FileToken {
  token: string;
  /** Epoch ms — the client refreshes shortly before this. */
  expiresAt: number;
}

export function signFileToken(documentId: string, ttlMs = FILE_TOKEN_TTL_MS): FileToken {
  const expiresAt = Date.now() + ttlMs;
  return { token: `${expiresAt}.${sign(documentId, expiresAt)}`, expiresAt };
}

export function verifyFileToken(documentId: string, token: unknown): boolean {
  if (typeof token !== "string" || !token) return false;

  const dot = token.indexOf(".");
  if (dot <= 0) return false;

  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || Date.now() > exp) return false;

  // Compare in constant time so a wrong signature can't be recovered byte by
  // byte from response timings.
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(documentId, exp), "utf8");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

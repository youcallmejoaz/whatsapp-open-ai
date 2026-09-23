import { createHmac, timingSafeEqual } from 'node:crypto';

/** Compute the X-Hub-Signature-256 header value Meta sends with each webhook. */
export function signPayload(rawBody: Buffer | string, appSecret: string): string {
  return 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

/**
 * Verify a webhook against the app secret. Must run over the exact raw bytes:
 * re-serialising parsed JSON changes escaping (notably for Arabic text) and
 * breaks the HMAC.
 */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(signPayload(rawBody, appSecret));
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

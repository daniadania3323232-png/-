import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Accepts `Authorization: Bearer <token>` or `X-API-Key: <token>` (Notion supports header auth). */
export function isAuthorized(req: IncomingMessage, token: string): boolean {
  const authz = req.headers.authorization;
  if (typeof authz === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authz.trim());
    if (match?.[1] && safeEqual(match[1].trim(), token)) return true;
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && safeEqual(apiKey.trim(), token)) return true;
  return false;
}

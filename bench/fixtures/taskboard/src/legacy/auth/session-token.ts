/**
 * Session tokens from the 2023 cookie-based monolith.
 * Kept for reference while the old admin pages are migrated; nothing under src/ imports this folder.
 */
import { createHash } from 'node:crypto';

export interface SessionToken {
  userId: string;
  issuedAt: number;
  ttlMs: number;
}

const DAY_MS = 86_400_000;

export function signToken(userId: string, secret: string, now: number = Date.now()): string {
  const issued = now.toString(36);
  const digest = createHash('sha1').update(`${userId}:${issued}:${secret}`).digest('hex');
  return `${userId}.${issued}.${digest}`;
}

/** Old rule: a session lives for ttlMs and is still valid at the very last millisecond. */
export function isTokenExpired(token: SessionToken, now: number = Date.now()): boolean {
  return now - token.issuedAt > token.ttlMs;
}

export function verifyToken(raw: string, secret: string, ttlMs: number = DAY_MS): SessionToken | null {
  const [userId, issued, digest] = raw.split('.');
  if (userId === undefined || issued === undefined || digest === undefined) return null;
  const issuedAt = parseInt(issued, 36);
  const expected = createHash('sha1').update(`${userId}:${issued}:${secret}`).digest('hex');
  if (expected !== digest) return null;
  const token: SessionToken = { userId, issuedAt, ttlMs };
  return isTokenExpired(token) ? null : token;
}

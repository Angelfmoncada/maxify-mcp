import { createHmac, timingSafeEqual } from 'node:crypto';
import { DEFAULT_TOKEN_TTL_SECONDS } from '../../shared/constants.ts';
import { UnauthorizedError } from '../../shared/errors.ts';
import type { Role } from '../../shared/types.ts';

export interface TokenPayload {
  /** User id. */
  sub: string;
  email: string;
  role: Role;
  /** Issued-at time, in seconds since the epoch. */
  iat: number;
  /** Expiry time, in seconds since the epoch. The token is invalid from this second on. */
  exp: number;
}

export interface SignOptions {
  ttlSeconds?: number;
  /** Clock override in milliseconds; tests use it to issue tokens in the past. */
  nowMs?: number;
}

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'TBT' })).toString('base64url');

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function isTokenPayload(value: unknown): value is TokenPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sub === 'string' &&
    typeof candidate.email === 'string' &&
    typeof candidate.role === 'string' &&
    typeof candidate.iat === 'number' &&
    typeof candidate.exp === 'number'
  );
}

/** Issues a compact `header.payload.signature` token for the given identity. */
export function signToken(
  claims: Pick<TokenPayload, 'sub' | 'email' | 'role'>,
  secret: string,
  options: SignOptions = {},
): string {
  const issuedAt = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const payload: TokenPayload = {
    ...claims,
    iat: issuedAt,
    exp: issuedAt + (options.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${HEADER}.${body}.${sign(`${HEADER}.${body}`, secret)}`;
}

/** Reads the payload without checking signature or expiry. Throws UnauthorizedError when malformed. */
export function decodeToken(token: string): TokenPayload {
  const parts = token.split('.');
  const body = parts[1];
  if (parts.length !== 3 || body === undefined) throw new UnauthorizedError('Malformed token');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new UnauthorizedError('Malformed token');
  }
  if (!isTokenPayload(parsed)) throw new UnauthorizedError('Malformed token');
  return parsed;
}

/**
 * A token is expired from its `exp` second onwards: at `exp` exactly it is already invalid.
 * `nowMs` is a millisecond timestamp, `exp` is in seconds.
 */
export function isExpired(payload: Pick<TokenPayload, 'exp'>, nowMs: number = Date.now()): boolean {
  return Math.floor(nowMs / 1000) >= payload.exp;
}

/** Verifies signature and expiry and returns the payload. Throws UnauthorizedError otherwise. */
export function verifyToken(token: string, secret: string, nowMs: number = Date.now()): TokenPayload {
  const [header, body, signature] = token.split('.');
  if (header === undefined || body === undefined || signature === undefined) {
    throw new UnauthorizedError('Malformed token');
  }
  const expected = Buffer.from(sign(`${header}.${body}`, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new UnauthorizedError('Invalid token signature');
  }
  const payload = decodeToken(token);
  if (isExpired(payload, nowMs)) throw new UnauthorizedError('Token expired');
  return payload;
}

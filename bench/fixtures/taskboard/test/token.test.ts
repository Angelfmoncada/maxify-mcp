import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeToken, isExpired, signToken, verifyToken } from '../src/server/auth/token.ts';
import { UnauthorizedError } from '../src/shared/errors.ts';

const SECRET = 'unit-test-secret';
const CLAIMS = { sub: 'user_1', email: 'ada@example.com', role: 'member' } as const;
const ISSUED_AT_MS = Date.UTC(2025, 0, 15, 12, 0, 0);

describe('signToken and decodeToken', () => {
  it('round-trips the claims and derives exp from the ttl', () => {
    const token = signToken(CLAIMS, SECRET, { ttlSeconds: 600, nowMs: ISSUED_AT_MS });
    const payload = decodeToken(token);
    assert.equal(payload.sub, 'user_1');
    assert.equal(payload.email, 'ada@example.com');
    assert.equal(payload.role, 'member');
    assert.equal(payload.exp - payload.iat, 600);
  });

  it('defaults to a one hour lifetime', () => {
    const payload = decodeToken(signToken(CLAIMS, SECRET, { nowMs: ISSUED_AT_MS }));
    assert.equal(payload.exp - payload.iat, 3600);
  });

  it('refuses tokens that do not have three parts', () => {
    assert.throws(() => decodeToken('not-a-token'), UnauthorizedError);
  });
});

describe('isExpired', () => {
  it('is false while the token still has time left', () => {
    assert.equal(isExpired({ exp: 2_000 }, 1_000_000), false);
  });

  it('is true once the expiry lies well in the past', () => {
    assert.equal(isExpired({ exp: 1_000 }, 5_000_000), true);
  });
});

describe('verifyToken', () => {
  it('returns the payload of a fresh token', () => {
    const token = signToken(CLAIMS, SECRET, { ttlSeconds: 600, nowMs: ISSUED_AT_MS });
    const payload = verifyToken(token, SECRET, ISSUED_AT_MS + 1_000);
    assert.equal(payload.sub, 'user_1');
  });

  it('rejects a token signed with a different secret', () => {
    const token = signToken(CLAIMS, 'another-secret', { nowMs: ISSUED_AT_MS });
    assert.throws(() => verifyToken(token, SECRET, ISSUED_AT_MS), /signature/);
  });

  it('rejects a payload that was edited after signing', () => {
    const token = signToken(CLAIMS, SECRET, { nowMs: ISSUED_AT_MS });
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...CLAIMS, role: 'admin', iat: 1, exp: 9_999_999_999 }));
    const tampered = `${header}.${forged.toString('base64url')}.${signature}`;
    assert.throws(() => verifyToken(tampered, SECRET, ISSUED_AT_MS), UnauthorizedError);
  });

  it('rejects a token that expired minutes ago', () => {
    const token = signToken(CLAIMS, SECRET, { ttlSeconds: 60, nowMs: ISSUED_AT_MS });
    assert.throws(
      () => verifyToken(token, SECRET, ISSUED_AT_MS + 10 * 60_000),
      (error: unknown) => error instanceof UnauthorizedError && /expired/i.test(error.message),
    );
  });
});

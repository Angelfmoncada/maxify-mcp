import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/server/app.ts';
import { isExpired, signToken, verifyToken } from '../src/server/auth/token.ts';
import { silentLogger } from '../src/server/util/logger.ts';
import { UnauthorizedError } from '../src/shared/errors.ts';

const SECRET = 'hidden-test-secret-0123456789';
const CLAIMS = { sub: 'user_hidden', email: 'hidden@example.com', role: 'member' } as const;
const ISSUED_MS = Date.UTC(2025, 5, 1, 8, 0, 0);

describe('token expiry boundary', () => {
  it('isExpired is true from the exp second onwards', () => {
    assert.equal(isExpired({ exp: 1_000 }, 999_999), false);
    assert.equal(isExpired({ exp: 1_000 }, 1_000_000), true);
    assert.equal(isExpired({ exp: 1_000 }, 1_000_999), true);
    assert.equal(isExpired({ exp: 1_000 }, 1_001_000), true);
  });

  it('verifyToken rejects a token during the second in which it expires', () => {
    const token = signToken(CLAIMS, SECRET, { ttlSeconds: 60, nowMs: ISSUED_MS });
    assert.equal(verifyToken(token, SECRET, ISSUED_MS + 59_999).sub, 'user_hidden');
    assert.throws(() => verifyToken(token, SECRET, ISSUED_MS + 60_000), UnauthorizedError);
  });

  it('the API answers 200 one millisecond before expiry and 401 at the expiry second', async () => {
    let nowMs = ISSUED_MS;
    const app = createApp({
      env: { NODE_ENV: 'test' },
      config: { tokenSecret: SECRET, tokenTtlSeconds: 60 },
      now: () => new Date(nowMs),
      logger: silentLogger,
    });
    const registered = await app.handle({
      method: 'POST',
      url: '/auth/register',
      body: { email: 'boundary@example.com', name: 'Boundary', password: 'correct-horse-battery' },
    });
    assert.equal(registered.status, 201);
    const token = (registered.body as { token: string }).token;
    const headers = { authorization: `Bearer ${token}` };

    nowMs = ISSUED_MS + 59_999;
    assert.equal((await app.handle({ method: 'GET', url: '/tasks', headers })).status, 200);
    nowMs = ISSUED_MS + 60_000;
    assert.equal((await app.handle({ method: 'GET', url: '/tasks', headers })).status, 401);
  });
});

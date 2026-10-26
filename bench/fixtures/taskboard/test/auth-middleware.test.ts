import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractBearerToken, requireAuth, requireRole } from '../src/server/auth/middleware.ts';
import { signToken } from '../src/server/auth/token.ts';
import type { HttpRequest, HttpResponse } from '../src/server/http/types.ts';
import { ForbiddenError, UnauthorizedError } from '../src/shared/errors.ts';
import type { AuthUser } from '../src/shared/types.ts';
import { makeUser } from './helpers/factories.ts';

const SECRET = 'middleware-secret';
const NOW_MS = Date.UTC(2025, 0, 15, 12, 0, 0);
const PASSED: HttpResponse = { status: 200, headers: {}, body: 'passed' };

function request(headers: Record<string, string> = {}, user?: AuthUser): HttpRequest {
  return {
    method: 'GET',
    path: '/tasks',
    query: {},
    params: {},
    headers,
    body: undefined,
    ...(user !== undefined ? { user } : {}),
  };
}

describe('extractBearerToken', () => {
  it('reads the token of a Bearer header', () => {
    assert.equal(extractBearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
  });

  it('is case-insensitive about the scheme', () => {
    assert.equal(extractBearerToken('bearer abc'), 'abc');
  });

  it('returns null for other schemes and missing headers', () => {
    assert.equal(extractBearerToken('Basic dXNlcjpwYXNz'), null);
    assert.equal(extractBearerToken(undefined), null);
  });
});

describe('requireAuth', () => {
  it('forwards the verified identity as request.user', async () => {
    const token = signToken({ sub: 'user_9', email: 'z@example.com', role: 'admin' }, SECRET, { nowMs: NOW_MS });
    let forwarded: AuthUser | undefined;
    const response = await requireAuth(SECRET, () => NOW_MS)(
      request({ authorization: `Bearer ${token}` }),
      async (next) => {
        forwarded = next?.user;
        return PASSED;
      },
    );
    assert.equal(response, PASSED);
    assert.deepEqual(forwarded, { id: 'user_9', email: 'z@example.com', role: 'admin' });
  });

  it('answers 401 when the header is missing', async () => {
    await assert.rejects(
      requireAuth(SECRET, () => NOW_MS)(request(), async () => PASSED),
      UnauthorizedError,
    );
  });

  it('rejects a token that expired an hour ago', async () => {
    const token = signToken({ sub: 'user_9', email: 'z@example.com', role: 'member' }, SECRET, {
      ttlSeconds: 60,
      nowMs: NOW_MS - 3_600_000,
    });
    await assert.rejects(
      requireAuth(SECRET, () => NOW_MS)(request({ authorization: `Bearer ${token}` }), async () => PASSED),
      /expired/,
    );
  });
});

describe('requireRole', () => {
  it('lets a listed role through', async () => {
    const response = await requireRole('admin', 'member')(request({}, makeUser({ role: 'member' })), async () => PASSED);
    assert.equal(response, PASSED);
  });

  it('forbids a role that is not listed', async () => {
    await assert.rejects(
      requireRole('admin')(request({}, makeUser({ role: 'viewer' })), async () => PASSED),
      ForbiddenError,
    );
  });

  it('answers 401 when no user was attached', async () => {
    await assert.rejects(requireRole('admin')(request(), async () => PASSED), UnauthorizedError);
  });
});

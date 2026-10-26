import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, verifyPassword } from '../src/server/auth/password.ts';
import { AuthService } from '../src/server/auth/service.ts';
import { verifyToken } from '../src/server/auth/token.ts';
import { UserRepository } from '../src/server/users/repository.ts';
import { ConflictError, UnauthorizedError } from '../src/shared/errors.ts';
import { ValidationError } from '../src/shared/validation.ts';
import { TEST_PASSWORD, TEST_SECRET, TestClock } from './helpers/factories.ts';

function createService(): { service: AuthService; users: UserRepository; clock: TestClock } {
  const clock = new TestClock();
  const users = new UserRepository();
  const service = new AuthService(users, { secret: TEST_SECRET, ttlSeconds: 1800, now: clock.nowMs });
  return { service, users, clock };
}

const alice = { email: 'alice@example.com', name: 'Alice', password: TEST_PASSWORD };
const bob = { email: 'bob@example.com', name: 'Bob', password: TEST_PASSWORD };

describe('password hashing', () => {
  it('verifies the original password and nothing else', async () => {
    const stored = await hashPassword('s3cret-passphrase');
    assert.equal(await verifyPassword('s3cret-passphrase', stored), true);
    assert.equal(await verifyPassword('wrong-passphrase', stored), false);
  });

  it('salts every hash', async () => {
    assert.notEqual(await hashPassword('same-input-1'), await hashPassword('same-input-1'));
  });

  it('refuses malformed stored values', async () => {
    assert.equal(await verifyPassword('anything', 'plain-text'), false);
  });
});

describe('AuthService.register', () => {
  it('makes the first account an admin and the following ones members', async () => {
    const { service } = createService();
    assert.equal((await service.register(alice)).user.role, 'admin');
    assert.equal((await service.register(bob)).user.role, 'member');
  });

  it('issues a token that lasts for the configured ttl', async () => {
    const { service, clock } = createService();
    const session = await service.register(alice);
    const payload = verifyToken(session.token, TEST_SECRET, clock.nowMs());
    assert.equal(payload.exp - payload.iat, 1800);
    assert.equal(session.expiresAt, new Date(clock.nowMs() + 1800 * 1000).toISOString());
  });

  it('never returns the password hash', async () => {
    const { service } = createService();
    const session = await service.register(alice);
    assert.equal('passwordHash' in session.user, false);
  });

  it('rejects a duplicate email regardless of case', async () => {
    const { service } = createService();
    await service.register(alice);
    await assert.rejects(service.register({ ...alice, email: 'ALICE@example.com' }), ConflictError);
  });

  it('validates the input', async () => {
    const { service } = createService();
    await assert.rejects(service.register({ email: 'nope', password: 'short', name: '' }), ValidationError);
  });
});

describe('AuthService.login', () => {
  it('accepts the right credentials', async () => {
    const { service } = createService();
    await service.register(alice);
    const session = await service.login({ email: alice.email, password: alice.password });
    assert.equal(session.user.email, 'alice@example.com');
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const { service } = createService();
    await service.register(alice);
    await assert.rejects(
      service.login({ email: alice.email, password: 'wrong-password-1' }),
      (error: unknown) => error instanceof UnauthorizedError && error.message === 'Invalid email or password',
    );
    await assert.rejects(
      service.login({ email: 'ghost@example.com', password: TEST_PASSWORD }),
      (error: unknown) => error instanceof UnauthorizedError && error.message === 'Invalid email or password',
    );
  });
});

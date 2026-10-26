import assert from 'node:assert/strict';
import { createApp } from '../../src/server/app.ts';
import type { App } from '../../src/server/app.ts';
import type { RawRequest } from '../../src/server/http/types.ts';
import { silentLogger } from '../../src/server/util/logger.ts';
import type { AuthUser, Task } from '../../src/shared/types.ts';

export const TEST_SECRET = 'test-secret-with-enough-length';
export const TEST_PASSWORD = 'correct-horse-battery';

/** A clock the test moves by hand, so token issue and expiry times are deterministic. */
export class TestClock {
  private current: number;

  constructor(startMs: number = Date.UTC(2025, 0, 15, 12, 0, 0)) {
    this.current = startMs;
  }

  now = (): Date => new Date(this.current);

  nowMs = (): number => this.current;

  advance(ms: number): void {
    this.current += ms;
  }
}

export function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return { id: 'user_member', email: 'member@example.com', role: 'member', ...overrides };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    title: 'Write the release notes',
    description: '',
    status: 'todo',
    priority: 'medium',
    ownerId: 'user_member',
    dueDate: null,
    createdAt: '2025-01-15T12:00:00.000Z',
    updatedAt: '2025-01-15T12:00:00.000Z',
    ...overrides,
  };
}

export function createTestApp(): { app: App; clock: TestClock } {
  const clock = new TestClock();
  const app = createApp({
    env: { NODE_ENV: 'test' },
    config: { tokenSecret: TEST_SECRET, tokenTtlSeconds: 3600 },
    now: clock.now,
    logger: silentLogger,
  });
  return { app, clock };
}

export interface Session {
  token: string;
  userId: string;
}

/** Registers an account through the API. The first account created in an app is the admin. */
export async function signUp(app: App, email: string, name: string = 'Test User'): Promise<Session> {
  const response = await app.handle({
    method: 'POST',
    url: '/auth/register',
    body: { email, name, password: TEST_PASSWORD },
  });
  assert.equal(response.status, 201);
  const body = response.body as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id };
}

export function authed(session: Session, method: string, url: string, body?: unknown): RawRequest {
  return { method, url, headers: { authorization: `Bearer ${session.token}` }, body };
}
